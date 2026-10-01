import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import {
  OPEN_STATUSES,
  STATUSES,
  addHistory,
  addOpportunity,
  deleteOpportunity,
  findDuplicate,
  getOpportunity,
  listOpportunities,
  recentHistory,
  updateOpportunity,
  type Opportunity,
  type Status,
} from "./db.js";
import { nowLocal, oneLine, utcOffset } from "./format.js";

const client = new Anthropic();
const MAX_TURNS = 12;
const HISTORY_TURNS = 12;

const SYSTEM_PROMPT = `You are an opportunity-tracking assistant that lives in the user's WhatsApp. The user forwards you opportunities they find online (scholarships, fellowships, jobs, internships, grants, competitions, conferences, hackathons, calls for applications), usually as a link, a pasted post, a screenshot or a flyer. You keep track of them and help the user apply before deadlines.

When the user sends a new opportunity:
1. Research it. Fetch the link if there is one, and search the web for the official page so you have the real deadline (date, time and timezone), eligibility, requirements/documents needed, benefits/funding, location and the official application link. Prefer official sources over aggregator sites. If sources disagree on the deadline, use the official one and mention the conflict in notes.
2. Save it with save_opportunity. Convert the deadline to an ISO 8601 timestamp with an explicit UTC offset. If only a date is given, use 23:59 in the deadline's stated timezone, or the user's timezone if none is stated. Use null if you genuinely cannot find a deadline, and say so.
3. Reply with a short brief: what it is, deadline and time left, who is eligible, what they need to prepare, and the link. Flag anything that makes the user ineligible or that is urgent.

The user also tells you about progress in plain language ("started the Mastercard one", "submitted #4", "not doing the Google one"). Map that onto an opportunity and call update_opportunity. Statuses: not_started, in_progress, submitted, accepted, rejected, skipped. If it is ambiguous which opportunity they mean, ask. When they ask what's pending, what they've applied to, what's due this week, and so on, answer from the tracked list you are given, calling list_opportunities if you need the full details.

Reminders are sent automatically starting ${config.reminderDays} days before each deadline for anything not_started or in_progress, so you never need to schedule them.

Style: you are writing WhatsApp messages. Keep them short and scannable. WhatsApp formatting only: *bold*, _italic_, "- " bullets. No markdown headings, tables or [text](url) links; paste raw URLs. Refer to opportunities as #id.`;

const nullableString = (description: string) => ({
  type: ["string", "null"],
  description,
});

const tools: Anthropic.Beta.BetaToolUnion[] = [
  {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
  },
  {
    type: "web_fetch_20260209",
    name: "web_fetch",
    max_uses: 5,
  },
  {
    name: "save_opportunity",
    description:
      "Save a newly found opportunity to the tracker. Fails if it is already tracked, in which case use update_opportunity instead.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "title", "organization", "category", "url", "deadline", "summary",
        "eligibility", "requirements", "benefits", "location", "notes",
      ],
      properties: {
        title: { type: "string", description: "Short, recognisable name of the opportunity" },
        organization: nullableString("Who runs it"),
        category: nullableString("e.g. scholarship, fellowship, job, internship, grant, competition, conference"),
        url: nullableString("Official application or info URL"),
        deadline: nullableString("ISO 8601 with UTC offset, e.g. 2026-11-30T23:59:00+01:00. Null if unknown"),
        summary: nullableString("One to three sentences on what it is"),
        eligibility: nullableString("Who can apply"),
        requirements: nullableString("Documents and steps needed to apply"),
        benefits: nullableString("Funding, stipend, salary, prizes, perks"),
        location: nullableString("Where it takes place, or remote"),
        notes: nullableString("Anything else worth remembering, e.g. conflicting deadlines"),
      },
    },
  },
  {
    name: "update_opportunity",
    description:
      "Change a tracked opportunity: its status (when the user starts, submits, gets a result or decides to skip) or any details. Pass null for fields that should stay unchanged.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "status", "title", "deadline", "url", "requirements", "notes"],
      properties: {
        id: { type: "integer" },
        status: { type: ["string", "null"], enum: [...STATUSES, null] },
        title: nullableString("New title"),
        deadline: nullableString("New deadline, ISO 8601 with UTC offset"),
        url: nullableString("New URL"),
        requirements: nullableString("Replacement requirements text"),
        notes: nullableString("Replacement notes text (include any earlier notes worth keeping)"),
      },
    },
  },
  {
    name: "list_opportunities",
    description: "Get full details of tracked opportunities, optionally filtered by status.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["statuses"],
      properties: {
        statuses: {
          type: ["array", "null"],
          items: { type: "string", enum: [...STATUSES] },
          description: "Only these statuses; null for all",
        },
      },
    },
  },
  {
    name: "delete_opportunity",
    description:
      "Permanently remove an opportunity. Only when the user explicitly asks to delete it; to stop tracking, prefer status skipped.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer" } },
    },
  },
];

class ToolError extends Error {}

function normalizeDeadline(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ToolError(`Could not parse deadline "${value}". Use ISO 8601 with a UTC offset.`);
  }
  return date.toISOString();
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function details(o: Opportunity): string {
  return JSON.stringify(o);
}

function runTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "save_opportunity": {
      const title = str(input.title);
      if (!title) throw new ToolError("title is required");
      const url = str(input.url);
      const existing = findDuplicate(title, url);
      if (existing) {
        throw new ToolError(
          `Already tracked as #${existing.id}: ${details(existing)}. Use update_opportunity if anything changed.`,
        );
      }
      const saved = addOpportunity({
        title,
        url,
        deadline: normalizeDeadline(input.deadline),
        organization: str(input.organization),
        category: str(input.category),
        summary: str(input.summary),
        eligibility: str(input.eligibility),
        requirements: str(input.requirements),
        benefits: str(input.benefits),
        location: str(input.location),
        notes: str(input.notes),
      });
      return `Saved as #${saved.id}: ${details(saved)}`;
    }
    case "update_opportunity": {
      const id = Number(input.id);
      if (!getOpportunity(id)) throw new ToolError(`No opportunity #${id}`);
      const changes: Parameters<typeof updateOpportunity>[1] = {};
      if (input.status != null) {
        if (!STATUSES.includes(input.status as Status)) throw new ToolError("Invalid status");
        changes.status = input.status as Status;
      }
      if (input.deadline != null) changes.deadline = normalizeDeadline(input.deadline);
      const title = str(input.title);
      if (title) changes.title = title;
      for (const key of ["url", "requirements", "notes"] as const) {
        if (input[key] != null) changes[key] = str(input[key]);
      }
      const updated = updateOpportunity(id, changes)!;
      return `Updated #${id}: ${details(updated)}`;
    }
    case "list_opportunities": {
      const statuses = Array.isArray(input.statuses) ? (input.statuses as Status[]) : undefined;
      const rows = listOpportunities(statuses);
      return rows.length ? JSON.stringify(rows) : "No matching opportunities.";
    }
    case "delete_opportunity": {
      const id = Number(input.id);
      if (!deleteOpportunity(id)) throw new ToolError(`No opportunity #${id}`);
      return `Deleted #${id}`;
    }
    default:
      throw new ToolError(`Unknown tool ${name}`);
  }
}

/** Fresh state for each request: the time and a compact view of the tracker. */
function contextNote(): string {
  const open = listOpportunities(OPEN_STATUSES);
  const others = listOpportunities().filter((o) => !OPEN_STATUSES.includes(o.status));
  const lines = [
    `Current time for the user: ${nowLocal()} (${config.timezone}, UTC${utcOffset()}).`,
    "",
    "Tracked opportunities still needing action:",
    open.length ? open.map(oneLine).join("\n") : "(none)",
    "",
    `Other tracked opportunities: ${others.length ? others.map((o) => `#${o.id} ${o.title} [${o.status}]`).join("; ") : "(none)"}`,
  ];
  return lines.join("\n");
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * Handle one incoming WhatsApp message and return the reply text.
 * `historyText` is the plain-text version stored for follow-up context.
 */
export async function handleMessage(
  content: Anthropic.Beta.BetaContentBlockParam[],
  historyText: string,
): Promise<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = recentHistory(HISTORY_TURNS).map((h) => ({
    role: h.role,
    content: h.text,
  }));
  messages.push({ role: "user", content });
  messages.push({ role: "system", content: contextNote() });

  let reply = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      reply = "Sorry, I can't help with that one.";
      break;
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      reply = textOf(response);
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use) => {
      try {
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: runTool(use.name, use.input as Record<string, unknown>),
        };
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        return { type: "tool_result", tool_use_id: use.id, is_error: true, content: err.message };
      }
    });
    messages.push({ role: "user", content: results });
  }

  reply ||= "Done.";
  addHistory("user", historyText);
  addHistory("assistant", reply);
  return reply;
}
