import Anthropic from "@anthropic-ai/sdk";
import { handleMessage } from "./agent.js";
import { config } from "./config.js";
import { claimMessage } from "./db.js";
import { closingSoonDigest, startReminders, weeklyOverview } from "./reminders.js";
import { WhatsApp, type IncomingMessage } from "./whatsapp.js";

const HELP = `*Opportunity tracker*
Forward me a link, post, screenshot or PDF of an opportunity and I'll research it and track the deadline.

Tell me about progress in plain words: "started #2", "submitted the Chevening one", "skip #5".
Ask anything: "what's due this week?", "what haven't I started?"

Shortcuts: /list (everything), /soon (closing soon), /help`;

/** Instant replies that don't need Claude. */
function shortcut(text: string): string | null {
  switch (text.trim().toLowerCase()) {
    case "/help":
      return HELP;
    case "/list":
      return weeklyOverview().replace("Weekly overview", "Overview");
    case "/soon":
      return closingSoonDigest() ?? `Nothing closes in the next ${config.reminderDays} days. 🎉`;
    default:
      return null;
  }
}

let queue = Promise.resolve();

async function handleIncoming(msg: IncomingMessage): Promise<void> {
  if (!claimMessage(msg.key.id!)) return;

  const quick = shortcut(msg.historyText);
  if (quick) return whatsapp.send(quick);

  await whatsapp.react(msg.key, "⏳");
  try {
    const reply = await handleMessage(msg.content, msg.historyText);
    await whatsapp.send(reply);
    await whatsapp.react(msg.key, "✅");
  } catch (err) {
    console.error("Failed to handle message", err);
    await whatsapp.react(msg.key, "❌");
    const detail =
      err instanceof Anthropic.RateLimitError
        ? "I'm being rate limited. Try again in a minute."
        : err instanceof Anthropic.AuthenticationError
          ? "My Anthropic API key isn't working. Check ANTHROPIC_API_KEY."
          : "Something went wrong on my side. Please send that again.";
    await whatsapp.send(detail).catch(() => {});
  }
}

const whatsapp = new WhatsApp((msg) => {
  // One at a time, so tracker updates never race each other.
  queue = queue.then(() => handleIncoming(msg)).catch((err) => console.error(err));
});

await whatsapp.start();
startReminders((text) => whatsapp.send(text), () => whatsapp.isConnected);
