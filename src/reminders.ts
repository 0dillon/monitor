import { Cron } from "croner";
import { config } from "./config.js";
import {
  OPEN_STATUSES,
  STATUSES,
  listOpportunities,
  markReminderSent,
  reminderSent,
  type Opportunity,
} from "./db.js";
import { STATUS_LABEL, oneLine } from "./format.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Last-minute pings, on top of the daily digests. */
const URGENT = [
  { kind: "h1", hours: 1, text: "🚨 *Closes in about an hour!*" },
  { kind: "h6", hours: 6, text: "⚠️ *Closes in a few hours*" },
];

type Send = (text: string) => Promise<void>;

const msLeft = (o: Opportunity) => new Date(o.deadline!).getTime() - Date.now();

function openWithDeadline(): Opportunity[] {
  return listOpportunities(OPEN_STATUSES).filter((o) => o.deadline && msLeft(o) > 0);
}

function nudge(o: Opportunity): string {
  return o.status === "not_started"
    ? "   👉 You haven't started this yet."
    : "   👉 You've started. Finish and submit!";
}

export function closingSoonDigest(): string | null {
  const soon = openWithDeadline().filter((o) => msLeft(o) <= config.reminderDays * DAY);
  if (soon.length === 0) return null;
  const items = soon.map((o) => {
    const flag = msLeft(o) <= DAY ? "🚨 " : "";
    return `${flag}${oneLine(o)}\n${nudge(o)}`;
  });
  return [
    `⏰ *Closing in the next ${config.reminderDays} days*`,
    "",
    items.join("\n\n"),
    "",
    "_Reply e.g. \"submitted #3\" or \"skip #5\" to update._",
  ].join("\n");
}

export function weeklyOverview(): string {
  const all = listOpportunities();
  const counts = STATUSES.map((s) => [s, all.filter((o) => o.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${STATUS_LABEL[s]}: ${n}`);
  const open = listOpportunities(OPEN_STATUSES);
  const upcoming = open.filter((o) => !o.deadline || msLeft(o) > 0);
  const missed = open.filter((o) => o.deadline && msLeft(o) <= 0 && msLeft(o) > -7 * DAY);

  const lines = ["📋 *Weekly overview*", "", counts.join("\n") || "Nothing tracked yet."];
  if (upcoming.length) lines.push("", "*Still to do:*", upcoming.map(oneLine).join("\n"));
  if (missed.length) {
    lines.push("", "*Closed this week without a submission:*", missed.map(oneLine).join("\n"));
  }
  return lines.join("\n");
}

async function sendUrgentPings(send: Send): Promise<void> {
  for (const o of openWithDeadline()) {
    // Most urgent first, so a late-added item gets one ping, not two.
    const due = URGENT.find((u) => msLeft(o) <= u.hours * HOUR);
    if (!due || reminderSent(o.id, due.kind)) continue;
    await send(`${due.text}\n\n${oneLine(o)}\n${o.url ? `   ${o.url}\n` : ""}${nudge(o)}`);
    for (const u of URGENT.filter((x) => x.hours >= due.hours)) markReminderSent(o.id, u.kind);
  }
}

export function startReminders(send: Send, isReady: () => boolean): void {
  const opts = { timezone: config.timezone, protect: true };
  const safely = (name: string, job: () => Promise<void>) => async () => {
    if (!isReady()) return console.warn(`Skipping ${name}: WhatsApp not connected`);
    try {
      await job();
    } catch (err) {
      console.error(`${name} failed`, err);
    }
  };

  new Cron("*/10 * * * *", opts, safely("urgent pings", () => sendUrgentPings(send)));

  config.digestTimes.forEach((time, index) => {
    const [hour, minute] = time.split(":").map(Number);
    new Cron(
      `${minute || 0} ${hour} * * *`,
      opts,
      safely(`digest ${time}`, async () => {
        const isMonday =
          new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, weekday: "short" }).format(
            new Date(),
          ) === "Mon";
        // Monday mornings get the full overview as well.
        if (index === 0 && isMonday) await send(weeklyOverview());
        const digest = closingSoonDigest();
        if (digest) await send(digest);
      }),
    );
  });

  console.log(
    `⏰ Reminders on: digests at ${config.digestTimes.join(", ")} ${config.timezone}, starting ${config.reminderDays} days before each deadline.`,
  );
}
