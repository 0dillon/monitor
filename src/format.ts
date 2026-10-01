import { config } from "./config.js";
import type { Opportunity, Status } from "./db.js";

export const STATUS_LABEL: Record<Status, string> = {
  not_started: "⚪ Not started",
  in_progress: "🟡 In progress",
  submitted: "🟢 Submitted",
  accepted: "🏆 Accepted",
  rejected: "🔴 Rejected",
  skipped: "⏭️ Skipped",
};

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: config.timezone,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

/** e.g. "2 days 4 hours left", "5 hours left", "closed 3 days ago". */
export function timeLeft(iso: string, from = new Date()): string {
  const ms = new Date(iso).getTime() - from.getTime();
  const hours = Math.abs(ms) / 3_600_000;
  const days = Math.floor(hours / 24);
  const remHours = Math.floor(hours % 24);
  let span: string;
  if (days >= 1) {
    span = `${days} day${days === 1 ? "" : "s"}`;
    if (days < 3 && remHours > 0) span += ` ${remHours}h`;
  } else if (hours >= 1) {
    const h = Math.round(hours);
    span = `${h} hour${h === 1 ? "" : "s"}`;
  } else {
    span = `${Math.max(1, Math.round(hours * 60))} min`;
  }
  return ms >= 0 ? `${span} left` : `closed ${span} ago`;
}

/** One-line summary used in lists, reminders and the agent's context. */
export function oneLine(o: Opportunity): string {
  const deadline = o.deadline
    ? `${formatDate(o.deadline)} (${timeLeft(o.deadline)})`
    : "no deadline found";
  const org = o.organization ? ` – ${o.organization}` : "";
  return `#${o.id} *${o.title}*${org}\n   ${STATUS_LABEL[o.status]} · ⏰ ${deadline}`;
}

/** Current local date/time, for the agent's context. */
export function nowLocal(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

/** The UTC offset of the configured timezone right now, e.g. "+01:00". */
export function utcOffset(): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  const offset = part?.replace("GMT", "") || "";
  return offset === "" ? "+00:00" : offset;
}
