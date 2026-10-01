import path from "node:path";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment (e.g. on the cloud host).
}

function list(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const digits = (s: string | undefined) => (s || "").replace(/\D/g, "");

export const config = {
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  timezone: process.env.TIMEZONE || "UTC",
  model: process.env.MODEL || "claude-opus-5-5",

  // Self-chat mode (default): the bot is linked to YOUR WhatsApp and only
  // listens to your "Message yourself" chat.
  // Contact mode: set OWNER_NUMBER and link the bot to a second number;
  // it then only talks to OWNER_NUMBER.
  ownerNumber: digits(process.env.OWNER_NUMBER),

  // Your number with country code, digits only, for pairing without a QR scan.
  pairingNumber: digits(process.env.PAIRING_NUMBER),

  // Times (HH:MM, local) to send the "closing soon" digest each day.
  digestTimes: list(process.env.DIGEST_TIMES, "09:00,19:00"),
  // How many days before a deadline the reminders start.
  reminderDays: Number(process.env.REMINDER_DAYS || 3),
};
