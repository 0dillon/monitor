import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

export const STATUSES = [
  "not_started",
  "in_progress",
  "submitted",
  "accepted",
  "rejected",
  "skipped",
] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that still need action, so they get reminders. */
export const OPEN_STATUSES: Status[] = ["not_started", "in_progress"];

export interface Opportunity {
  id: number;
  title: string;
  organization: string | null;
  category: string | null;
  url: string | null;
  deadline: string | null; // ISO 8601, UTC
  summary: string | null;
  eligibility: string | null;
  requirements: string | null;
  benefits: string | null;
  location: string | null;
  notes: string | null;
  status: Status;
  created_at: string;
  updated_at: string;
}

export type OpportunityFields = Omit<Opportunity, "id" | "status" | "created_at" | "updated_at">;

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "bot.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    organization TEXT, category TEXT, url TEXT, deadline TEXT,
    summary TEXT, eligibility TEXT, requirements TEXT, benefits TEXT,
    location TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders_sent (
    opportunity_id INTEGER NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (opportunity_id, kind)
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS processed_messages (id TEXT PRIMARY KEY, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

export function addOpportunity(fields: OpportunityFields): Opportunity {
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO opportunities
        (title, organization, category, url, deadline, summary, eligibility,
         requirements, benefits, location, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?)`,
    )
    .run(
      fields.title, fields.organization, fields.category, fields.url, fields.deadline,
      fields.summary, fields.eligibility, fields.requirements, fields.benefits,
      fields.location, fields.notes, ts, ts,
    );
  return getOpportunity(Number(result.lastInsertRowid))!;
}

export function getOpportunity(id: number): Opportunity | undefined {
  return db.prepare("SELECT * FROM opportunities WHERE id = ?").get(id) as Opportunity | undefined;
}

export function findDuplicate(title: string, url: string | null): Opportunity | undefined {
  return db
    .prepare(
      `SELECT * FROM opportunities
       WHERE lower(title) = lower(?) OR (? IS NOT NULL AND url = ?)
       LIMIT 1`,
    )
    .get(title, url, url) as Opportunity | undefined;
}

const UPDATABLE = new Set([
  "title", "organization", "category", "url", "deadline", "summary", "eligibility",
  "requirements", "benefits", "location", "notes", "status",
]);

export function updateOpportunity(
  id: number,
  changes: Partial<OpportunityFields & { status: Status }>,
): Opportunity | undefined {
  const entries = Object.entries(changes).filter(
    ([key, value]) => UPDATABLE.has(key) && value !== undefined,
  );
  if (entries.length > 0) {
    const sets = entries.map(([key]) => `${key} = ?`).join(", ");
    db.prepare(`UPDATE opportunities SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...entries.map(([, value]) => value as string | null),
      now(),
      id,
    );
    // A moved deadline should get a fresh set of reminders.
    if ("deadline" in changes) {
      db.prepare("DELETE FROM reminders_sent WHERE opportunity_id = ?").run(id);
    }
  }
  return getOpportunity(id);
}

export function deleteOpportunity(id: number): boolean {
  db.prepare("DELETE FROM reminders_sent WHERE opportunity_id = ?").run(id);
  return db.prepare("DELETE FROM opportunities WHERE id = ?").run(id).changes > 0;
}

export function listOpportunities(statuses?: Status[]): Opportunity[] {
  const rows = db
    .prepare("SELECT * FROM opportunities ORDER BY deadline IS NULL, deadline, id")
    .all() as unknown as Opportunity[];
  return statuses ? rows.filter((o) => statuses.includes(o.status)) : rows;
}

export function reminderSent(opportunityId: number, kind: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM reminders_sent WHERE opportunity_id = ? AND kind = ?")
    .get(opportunityId, kind);
}

export function markReminderSent(opportunityId: number, kind: string): void {
  db.prepare("INSERT OR IGNORE INTO reminders_sent (opportunity_id, kind) VALUES (?, ?)").run(
    opportunityId,
    kind,
  );
}

export function getKv(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setKv(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
}

/** Returns false if the message was already handled (e.g. replayed after a reconnect). */
export function claimMessage(id: string): boolean {
  return db.prepare("INSERT OR IGNORE INTO processed_messages (id, at) VALUES (?, ?)").run(id, now())
    .changes > 0;
}

export function addHistory(role: "user" | "assistant", text: string): void {
  db.prepare("INSERT INTO history (role, text, at) VALUES (?, ?, ?)").run(role, text, now());
}

export function recentHistory(limit: number): { role: "user" | "assistant"; text: string }[] {
  const rows = db
    .prepare("SELECT role, text FROM history ORDER BY id DESC LIMIT ?")
    .all(limit) as { role: "user" | "assistant"; text: string }[];
  return rows.reverse();
}
