/**
 * The session event envelope (ADR-023) — the ONE wire format of the CLI.
 *
 * Every agent session appends these, one JSON object per line, to its
 * `events.ndjson`; the same objects flow over the in-process bus to the
 * Mission Control TUI and out of `--json` pipes verbatim. Interactive and
 * headless are therefore the same program: the TUI is a renderer of this
 * stream, `jq` is another.
 *
 * This is a PUBLIC contract. Evolution is additive-only within `v: 1` — new
 * event types and new optional fields are fine; renaming/removing/retyping
 * anything is a `v` bump and a migration. The golden test in
 * `__tests__/events.test.ts` pins one sample of every type to make an
 * accidental break loud.
 *
 * Framework-free on purpose (zod only): the store, the runner, the TUI, and
 * external consumers' expectations all hang off this module.
 */
import { z } from "zod";

/** Bump ONLY on a breaking envelope change (see module doc). */
export const EVENT_SCHEMA_VERSION = 1 as const;

/** Where a session's lifecycle can be. `waiting` = idle between turns, inbox open. */
export const sessionStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Token/cost totals — always cumulative for the scope that carries them. */
export const turnUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;

/** Pipeline stages, mirrored verbatim from the engine's `StageKind`. */
export const stageKindSchema = z.enum([
  "evaluate",
  "plan",
  "enhance",
  "route",
  "execute",
  "judge",
  "revise",
  "complete",
]);

const base = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  sid: z.string().min(1),
  seq: z.number().int().positive(),
  ts: z.number().int().positive(),
};

export const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("session.start"),
    title: z.string(),
    prompt: z.string(),
    cwd: z.string(),
    model: z.string().optional(),
    agent: z.string().optional(),
    mode: z.enum(["conversation", "once"]),
    owner: z.enum(["tui", "worker"]),
    pid: z.number().int(),
  }),
  z.object({
    ...base,
    type: z.literal("session.state"),
    state: sessionStateSchema,
    reason: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("stage"),
    kind: stageKindSchema,
    label: z.string(),
    detail: z.string().optional(),
  }),
  // A user message is atomic (typed or piped in one piece); `turn` is the
  // 1-based turn it opens.
  z.object({
    ...base,
    type: z.literal("message"),
    role: z.literal("user"),
    text: z.string(),
    turn: z.number().int().positive(),
  }),
  // Assistant text streams as coalesced deltas, then lands whole in
  // `message.end` so `jq 'select(.type=="message.end")'` needs no reassembly.
  z.object({
    ...base,
    type: z.literal("message.delta"),
    text: z.string(),
    turn: z.number().int().positive(),
  }),
  z.object({
    ...base,
    type: z.literal("message.end"),
    text: z.string(),
    turn: z.number().int().positive(),
  }),
  z.object({
    ...base,
    type: z.literal("reasoning.delta"),
    text: z.string(),
    turn: z.number().int().positive(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.start"),
    name: z.string(),
    /** Tool input, JSON-stringified and capped at 2 KB. */
    input: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.end"),
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number().nonnegative(),
  }),
  // Cumulative per execution round — mirrors the engine's `onFileChange`.
  z.object({
    ...base,
    type: z.literal("diff"),
    changedFiles: z.array(z.string()),
    changedLines: z.number().int().nonnegative(),
  }),
  z.object({
    ...base,
    type: z.literal("turn.end"),
    turn: z.number().int().positive(),
    steps: z.number().int().nonnegative(),
    stopReason: z.string().optional(),
    changedFiles: z.array(z.string()),
    usage: turnUsageSchema,
  }),
  // Session-cumulative totals, emitted after every turn settles.
  z.object({
    ...base,
    type: z.literal("usage"),
    cumulative: turnUsageSchema,
  }),
  z.object({
    ...base,
    type: z.literal("error"),
    message: z.string(),
    fatal: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal("session.end"),
    state: z.enum(["done", "failed", "cancelled"]),
    summary: z.string(),
    durationMs: z.number().nonnegative(),
    usage: turnUsageSchema,
  }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent["type"];

/** The payload of an event before the store stamps `v`/`sid`/`seq`/`ts`. */
export type SessionEventInput = SessionEvent extends infer E
  ? E extends { type: string }
    ? Omit<E, "v" | "sid" | "seq" | "ts">
    : never
  : never;

/** One event → one NDJSON line (no trailing newline). */
export function serializeSessionEvent(event: SessionEvent): string {
  return JSON.stringify(event);
}

/**
 * Parse one NDJSON line. Tolerant by design — a torn tail line (a crash
 * mid-append), a blank, or a foreign object yields `null`, never a throw:
 * every reader of a live log must survive whatever it finds there.
 */
export function parseSessionEventLine(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = sessionEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** Zero usage, for initializers and reducers. */
export function emptyTurnUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Sum two usage totals (never mutates). */
export function addTurnUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Cap a JSON-ish string for the wire (tool inputs). Marks truncation. */
export function capForWire(value: string, max = 2048): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}
