/**
 * The JSON objects Tacho copies from Claude Code into a frame body, each kept
 * to an allow-list of its members (#4969).
 *
 * A body member ships inline in the envelope and lands in its own ClickHouse
 * column. The recorder redacts only a frame's `content`, so free text inside
 * a body member reaches the record whole: past redaction, and past a
 * workspace that keeps digests only. Claude Code puts free text in three
 * objects Tacho copies:
 *
 * - The transcript `origin` of a `user` record. For a message another agent
 *   sent (`kind: "peer"`), its `body` is the whole message.
 * - Each `background_tasks` entry on `Stop`. Its `description` is free text
 *   and its `command` is a shell command line.
 * - Each `session_crons` entry on `Stop`. Its `prompt` is the text the cron
 *   will send.
 *
 * Each object keeps only the members listed here, so a member Claude Code
 * adds later stays out until someone reads it and lists it. A kept string
 * goes through `redactText` and is cut to the envelope's 512-unit bound. A
 * value that is not a string, a finite number or a boolean is dropped.
 *
 * The lists match Claude Code 2.1.287's hook schema and the transcripts it
 * wrote in September 2026.
 */
import { redactText } from "../evidence/redaction";
import { cutAt } from "./tools";

/**
 * The members of a transcript `origin` that say who sent a prompt. Detectors
 * 6 and 7 read `kind`. A `peer` origin names the sending session with the
 * rest. A `task-notification` origin can carry `producer`.
 */
const ORIGIN_MEMBERS = [
  "kind",
  "producer",
  "from",
  "name",
  "msg_id",
  "fromSession",
  "fromMode",
  "senderTaskId",
  "verifiedPeerPid",
] as const;

/** The sessions a peer message passed through, as a list of ids. */
const ORIGIN_HOP_CHAIN = "hopChain";

/** A background task's identity and state, without its description or command. */
const BACKGROUND_TASK_MEMBERS = [
  "id",
  "type",
  "status",
  "agent_type",
  "server",
  "tool",
  "name",
] as const;

/** A session cron's identity and schedule, without the prompt it sends. */
const SESSION_CRON_MEMBERS = ["id", "schedule", "recurring"] as const;

/** The envelope's bound for a short string. */
const MEMBER_MAX = 512;

/** The most ids a kept `hopChain` holds. */
const HOP_CHAIN_MAX = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A scalar as the body keeps it, or undefined when it is not one. */
function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") {
    const redacted = redactText(value);
    return redacted.length > MEMBER_MAX
      ? cutAt(redacted, MEMBER_MAX)
      : redacted;
  }
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

/** The listed members of `value` that hold a scalar. */
function pick(
  value: Record<string, unknown>,
  members: readonly string[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const member of members) {
    const kept = scalar(value[member]);
    if (kept !== undefined) out[member] = kept;
  }
  return out;
}

/**
 * Each entry of a list kept to its members. An entry that is not an object
 * becomes `{}`, so the list keeps its length: the ARP export reads whether
 * the list is empty (`arp/bundle.ts`), and a list that shrank to nothing
 * would say no background work was pending when some was.
 */
function pickEach(
  value: unknown,
  members: readonly string[],
): Array<Record<string, string | number | boolean>> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => (isRecord(entry) ? pick(entry, members) : {}));
}

/**
 * The `prompt_origin` body member from a transcript `origin` or an adapter's
 * `prompt_origin`: who sent the prompt, without what they sent. Undefined for
 * a value that is not an object naming a `kind`.
 */
export function promptOriginOf(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  if (typeof kind !== "string" || kind.length === 0) return undefined;
  const origin: Record<string, unknown> = pick(value, ORIGIN_MEMBERS);
  const hops = value[ORIGIN_HOP_CHAIN];
  if (Array.isArray(hops)) {
    origin[ORIGIN_HOP_CHAIN] = hops
      .slice(0, HOP_CHAIN_MAX)
      .map(scalar)
      .filter((hop): hop is string => typeof hop === "string");
  }
  return origin;
}

/** The `background_tasks` body member from a `Stop` payload. */
export function backgroundTasksOf(
  value: unknown,
): Array<Record<string, string | number | boolean>> | undefined {
  return pickEach(value, BACKGROUND_TASK_MEMBERS);
}

/** The `session_crons` body member from a `Stop` payload. */
export function sessionCronsOf(
  value: unknown,
): Array<Record<string, string | number | boolean>> | undefined {
  return pickEach(value, SESSION_CRON_MEMBERS);
}
