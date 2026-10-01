import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  areJidsSameUser,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageContent,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";

/** Prefix on every bot message so it's easy to tell apart in the self-chat. */
const BOT_PREFIX = "🤖 ";
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_MESSAGE_AGE_S = 24 * 3600;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export interface IncomingMessage {
  key: WAMessageKey;
  /** Content blocks for Claude: text plus any image or PDF. */
  content: Anthropic.Beta.BetaContentBlockParam[];
  /** Plain-text version kept in conversation history. */
  historyText: string;
}

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

function textOf(content: WAMessageContent | undefined): string {
  if (!content) return "";
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ""
  );
}

export class WhatsApp {
  private sock?: WASocket;
  private connected = false;
  private pairingRequested = false;
  private readonly sentIds = new Set<string>();
  private readonly authDir = path.join(config.dataDir, "auth");

  constructor(private readonly onMessage: (msg: IncomingMessage) => void) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: Browsers.macOS("Chrome"),
      // Stay "offline" so your phone keeps getting notifications.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) await this.showPairing(sock, qr);

      if (connection === "open") {
        this.connected = true;
        console.log(`✅ WhatsApp connected as ${sock.user?.id}. Chat target: ${this.chatJid()}`);
      }

      if (connection === "close") {
        this.connected = false;
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          console.error("❌ Logged out from WhatsApp. Clearing session; restart to link again.");
          fs.rmSync(this.authDir, { recursive: true, force: true });
          process.exit(1);
        }
        console.log(`WhatsApp connection closed (${status ?? "unknown"}), reconnecting...`);
        setTimeout(() => this.start().catch((err) => console.error("Reconnect failed", err)), 3000);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const msg of messages) {
        this.parse(msg)
          .then((incoming) => incoming && this.onMessage(incoming))
          .catch((err) => console.error("Failed to read incoming message", err));
      }
    });
  }

  private async showPairing(sock: WASocket, qr: string): Promise<void> {
    if (!config.pairingNumber) {
      console.log("Scan this QR in WhatsApp > Linked devices > Link a device:");
      qrcode.generate(qr, { small: true });
      return;
    }
    if (this.pairingRequested) return;
    this.pairingRequested = true;
    const code = await sock.requestPairingCode(config.pairingNumber);
    console.log(
      `🔗 Pairing code: ${code}\n   WhatsApp > Linked devices > Link a device > "Link with phone number instead", then enter the code.`,
    );
  }

  /** The chat the bot talks in: your own self-chat, or OWNER_NUMBER's chat. */
  private chatJid(): string {
    if (config.ownerNumber) return `${config.ownerNumber}@s.whatsapp.net`;
    return jidNormalizedUser(this.sock?.user?.id);
  }

  private isFromUser(key: WAMessageKey): boolean {
    const jids = [key.remoteJid ?? undefined, key.remoteJidAlt];
    if (config.ownerNumber) {
      const owner = this.chatJid();
      return !key.fromMe && jids.some((j) => areJidsSameUser(j, owner));
    }
    const self = [this.sock?.user?.id, this.sock?.user?.lid];
    return !!key.fromMe && jids.some((j) => self.some((s) => s && areJidsSameUser(j, s)));
  }

  private async parse(msg: WAMessage): Promise<IncomingMessage | null> {
    const { key } = msg;
    if (!key.id || this.sentIds.has(key.id) || !this.isFromUser(key)) return null;
    const age = Date.now() / 1000 - Number(msg.messageTimestamp ?? 0);
    if (age > MAX_MESSAGE_AGE_S) return null;

    const content = normalizeMessageContent(msg.message);
    if (!content || content.reactionMessage || content.protocolMessage) return null;

    const text = textOf(content).trim();
    if (text.startsWith(BOT_PREFIX.trim())) return null;

    const ext = content.extendedTextMessage;
    const ctx =
      ext?.contextInfo ||
      content.imageMessage?.contextInfo ||
      content.documentMessage?.contextInfo ||
      content.videoMessage?.contextInfo;

    const parts: string[] = [];
    if (ctx?.isForwarded) parts.push("[Forwarded message]");
    if (text) parts.push(text);
    if (ext?.title || ext?.description) {
      parts.push(`[Link preview: ${[ext.title, ext.description].filter(Boolean).join(" - ")}]`);
    }
    const quoted = textOf(normalizeMessageContent(ctx?.quotedMessage ?? undefined));
    if (quoted) parts.push(`[Replying to: "${quoted.slice(0, 1500)}"]`);

    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    const media = await this.media(msg, content);
    if (media) {
      blocks.push(media.block);
      parts.push(media.label);
    }
    if (parts.length === 0) return null;
    blocks.push({ type: "text", text: parts.join("\n") });

    return { key, content: blocks, historyText: parts.join("\n") };
  }

  private async media(
    msg: WAMessage,
    content: WAMessageContent,
  ): Promise<{ block: Anthropic.Beta.BetaContentBlockParam; label: string } | null> {
    const image = content.imageMessage;
    const doc = content.documentMessage;
    const isPdf = doc?.mimetype === "application/pdf";
    if (!image && !isPdf) return null;

    const size = Number((image ?? doc)?.fileLength ?? 0);
    if (size > MAX_MEDIA_BYTES) return { block: { type: "text", text: "[File too large to read]" }, label: "[File too large]" };

    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: this.sock!.updateMediaMessage },
    );
    const data = buffer.toString("base64");

    if (image) {
      const mime = IMAGE_TYPES.find((t) => t === image.mimetype) ?? "image/jpeg";
      return {
        block: { type: "image", source: { type: "base64", media_type: mime, data } },
        label: "[Image attached]",
      };
    }
    return {
      block: { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
      label: `[PDF attached: ${doc?.fileName ?? "document.pdf"}]`,
    };
  }

  async send(text: string): Promise<void> {
    if (!this.sock || !this.connected) throw new Error("WhatsApp is not connected");
    const sent = await this.sock.sendMessage(this.chatJid(), { text: BOT_PREFIX + text });
    if (sent?.key.id) this.sentIds.add(sent.key.id);
  }

  async react(key: WAMessageKey, emoji: string): Promise<void> {
    if (!this.sock || !this.connected) return;
    const sent = await this.sock.sendMessage(key.remoteJid || this.chatJid(), {
      react: { text: emoji, key },
    });
    if (sent?.key.id) this.sentIds.add(sent.key.id);
  }
}
