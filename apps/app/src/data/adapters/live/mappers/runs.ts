// Pure mappers for the live runs adapter (Batch 3 lane A1): store records in,
// view models out. No I/O, so every branch has a unit test.
//
// Two stores hold runs today (plan §3.1, spec §3 "Run"):
//   - the run evidence ledger, `agent.agent_runs*` through @oxagen/run-ledger
//     (`arun_…` public ids), for runs an external engine submits evidence for;
//   - `tacho.sessions` (`tse_…`), for wrapped agents (Claude Code and friends).
//     Spec §3: "Claude Code and Stella call this a session".
//
// The rule every function here follows: a view-model field is filled only from
// a column that recorded it. When the view model requires a value the store did
// not record (the contract has no null for it), the row is not expressible and
// the read answers `not_backed` with the milestone and gap that will record it.
// It never substitutes a zero, a default, or a neighbouring column.
import type { TokenUsageByStepRow } from "@oxagen/telemetry";
import type { AttemptEventReadRecord, AttemptRecord } from "@oxagen/run-ledger";
import type { schema } from "@oxagen/database";
import type { z } from "zod";
import {
  AgentKey,
  EnforcementTier,
  type Money,
  ReplayGrade,
} from "@/data/contracts/common";
import {
  type Frame,
  type FrameKind,
  RunDetail,
  RunRow,
  type RunStatus,
} from "@/data/contracts/runs";
import {
  type GapId,
  type Milestone,
  notBacked,
  type Read,
  readError,
  readOk,
} from "@/data/not-backed";

// ---- Unrecorded fields ---------------------------------------------------------

/**
 * A required view-model field the store did not record for this run. Each maps
 * to the milestone and gap (plan §3.4) whose store records it.
 */
export type Unrecorded =
  | "operatorId"
  | "agentKey"
  | "turns"
  | "model"
  | "cost"
  | "cacheHitRate";

export const UNRECORDED_GAP: Record<
  Unrecorded,
  { milestone: Milestone; gap: GapId }
> = {
  // The trusted run identity (operator = initiating principal, agent key) is
  // written by the M1 recorder (spec §8.1). tacho ingest does not write
  // `initiating_principal_id` today, and a legacy ledger row carries none.
  operatorId: { milestone: "M1", gap: "G6" },
  agentKey: { milestone: "M1", gap: "G6" },
  // `turn_index` travels only in an inline model-call payload; an encrypted
  // payload hides it until frame bodies are recorded (G6).
  turns: { milestone: "M1", gap: "G6" },
  model: { milestone: "M1", gap: "G6" },
  // Whole-run cost and its token classes are `cost.run_totals` (G3).
  cost: { milestone: "M2", gap: "G3" },
  cacheHitRate: { milestone: "M2", gap: "G3" },
};

/** Identity first, so a page names the earliest milestone that unblocks it. */
const UNRECORDED_ORDER: readonly Unrecorded[] = [
  "operatorId",
  "agentKey",
  "turns",
  "model",
  "cost",
  "cacheHitRate",
];

export function notBackedFor(unrecorded: readonly Unrecorded[]) {
  const first = UNRECORDED_ORDER.find((field) => unrecorded.includes(field));
  if (!first) throw new Error("notBackedFor needs at least one field");
  const { milestone, gap } = UNRECORDED_GAP[first];
  return notBacked(milestone, gap);
}

/**
 * A draft value; or the fields that kept it from being one; or a record that
 * breaks its own column constraints (a status outside the CHECK).
 */
export type Mapped<T> =
  | { ok: true; value: T }
  | { ok: false; unrecorded: Unrecorded[] }
  | { ok: false; invalid: true };

/** The code a read answers when a mapped row fails its own view-model schema. */
export const RUN_RECORD_INVALID = "run_record_invalid";

// ---- Shared scalars --------------------------------------------------------------

export const USD = "USD";

/** Integer micro-units as the wire's decimal string; refuses a float or NaN. */
export function microsString(micros: number | bigint): string {
  if (typeof micros === "bigint") return micros.toString();
  if (!Number.isSafeInteger(micros))
    throw new RangeError(
      `cost micros must be a safe integer: ${String(micros)}`,
    );
  return String(micros);
}

/** A recorded enum value in spec vocabulary, or null for none or a foreign word. */
function enumOrNull<T extends string>(
  schema: z.ZodType<T>,
  value: string | null,
): T | null {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The agent key `org_ns.ws_ns.slug` (ADR-024), or null when a namespace or the
 * slug is missing, never a malformed `..slug`.
 */
export function composeAgentKey(
  orgNamespace: string | null,
  workspaceNamespace: string | null,
  slug: string | null,
): string | null {
  if (!orgNamespace || !workspaceNamespace || !slug) return null;
  return `${orgNamespace}.${workspaceNamespace}.${slug}`;
}

/**
 * Parse a mapped draft through its view-model schema: the adapter cannot hand a
 * page a shape the contract does not accept.
 */
function finish<T>(schema: z.ZodType<T>, mapped: Mapped<unknown>): Read<T> {
  if (!mapped.ok)
    return "invalid" in mapped
      ? readError(RUN_RECORD_INVALID, 500)
      : notBackedFor(mapped.unrecorded);
  const parsed = schema.safeParse(mapped.value);
  if (!parsed.success) return readError(RUN_RECORD_INVALID, 500);
  return readOk(parsed.data);
}

// ---- The ledger (`agent.agent_runs*`) ----------------------------------------------

/**
 * The `agent.agent_runs` columns a row is built from. RunStore's `RunSummary`
 * carries them for one run; the Fleet page query selects the same columns.
 */
export type LedgerRunCore = {
  runId: string;
  publicId: string;
  /** 1 = a preserved legacy row with no trusted identity; 2 = RunSpecV2. */
  specVersion: number;
  /** `agent_runs.status` (CHECK: pending, running, completed, failed, cancelled). */
  status: string;
  createdAt: Date;
  startedAt: Date | null;
};

/** The identity a run's typed V2 columns resolve to, joined in one query. */
export type LedgerRunIdentity = {
  workspaceSlug: string;
  orgNamespace: string | null;
  workspaceNamespace: string | null;
  /** `agent.agents.slug` for `agent_runs.agent_id`. */
  agentSlug: string | null;
  /** `iam.principals.public_id` for `agent_runs.initiating_principal_id`. */
  operatorPublicId: string | null;
  /** `agent_runs.spec->>'goal'`: the free-text task a run was admitted for. */
  goal: string | null;
};

/**
 * Counts folded from a run's V2 events (`agent.agent_run_events`). Turns and
 * steps are not rows of their own (spec §8.1): a step is one model call or one
 * tool call, and a turn is a distinct `turn_index` among model calls.
 */
export type LedgerEventRollup = {
  frames: number;
  modelCalls: number;
  toolCalls: number;
  /** Distinct inline `turn_index` values. */
  turnIndexes: number;
  /** Model calls whose payload is an encrypted blob, so its turn is unreadable. */
  opaqueModelCalls: number;
  /** `payload_inline->>'model'` of the latest inline model call. */
  lastModel: string | null;
};

export const EMPTY_ROLLUP: LedgerEventRollup = {
  frames: 0,
  modelCalls: 0,
  toolCalls: 0,
  turnIndexes: 0,
  opaqueModelCalls: 0,
  lastModel: null,
};

export type LedgerRunRecord = {
  run: LedgerRunCore;
  identity: LedgerRunIdentity;
  /** The durable event log is the authority: no events means zero of each. */
  rollup: LedgerEventRollup;
  /** The latest attempt seal, when the run is terminal. */
  sealedAt: Date | null;
  /** `token_usage` summed for `execution_step_id = agent_runs.id`; null = no row. */
  usage: TokenUsageByStepRow | null;
};

const LEDGER_RUN_STATUS: Readonly<Record<string, RunStatus>> = {
  pending: "live",
  running: "live",
  completed: "sealed",
  failed: "sealed",
  cancelled: "halted",
};

/**
 * Ledger run status → spec RunStatus, or null for a word outside the column's
 * CHECK. `pending` (admitted, no attempt yet) and `running` are both open runs:
 * live. Every terminal outcome is sealed (spec §8.3), except a cancel, which is
 * an operator or policy halt (§7.4).
 */
export function ledgerRunStatus(status: string): RunStatus | null {
  return Object.hasOwn(LEDGER_RUN_STATUS, status)
    ? (LEDGER_RUN_STATUS[status] ?? null)
    : null;
}

/** The latest seal among a run's attempts; null while any attempt is open. */
export function latestSealAt(attempts: readonly AttemptRecord[]): Date | null {
  let latest: Date | null = null;
  for (const attempt of attempts) {
    if (!attempt.seal) return null;
    if (!latest || attempt.seal.sealedAt > latest)
      latest = attempt.seal.sealedAt;
  }
  return latest;
}

/** Gateway-metered token spend. Absent means not metered, never zero. */
export function ledgerCost(usage: TokenUsageByStepRow | null): Money | null {
  if (!usage) return null;
  return {
    micros: microsString(usage.costMicros),
    currency: USD,
    basis: "gateway_observed",
  };
}

function ledgerRowDraft(record: LedgerRunRecord): Mapped<RunRow> {
  const { run, identity, rollup } = record;
  const agentKey = composeAgentKey(
    identity.orgNamespace,
    identity.workspaceNamespace,
    identity.agentSlug,
  );
  const operatorId = identity.operatorPublicId;
  const cost = ledgerCost(record.usage);
  const turnsRecorded = rollup.opaqueModelCalls === 0;
  const status = ledgerRunStatus(run.status);
  if (status === null) return { ok: false, invalid: true };
  if (
    agentKey === null ||
    operatorId === null ||
    cost === null ||
    !turnsRecorded
  ) {
    const unrecorded: Unrecorded[] = [];
    if (operatorId === null) unrecorded.push("operatorId");
    if (agentKey === null) unrecorded.push("agentKey");
    if (!turnsRecorded) unrecorded.push("turns");
    if (cost === null) unrecorded.push("cost");
    return { ok: false, unrecorded };
  }
  return {
    ok: true,
    value: {
      id: run.publicId,
      // G14: the light-tier namer has not run. Never the goal text.
      name: null,
      agentKey,
      operatorId,
      workspaceSlug: identity.workspaceSlug,
      status,
      turns: rollup.turnIndexes,
      steps: rollup.modelCalls + rollup.toolCalls,
      frames: rollup.frames,
      cost,
      // The ledger records no tier, grade or verdict (G6, G7).
      tier: null,
      grade: null,
      verdict: null,
      taskRef: identity.goal,
      startedAt: (run.startedAt ?? run.createdAt).toISOString(),
      sealedAt:
        status === "live" ? null : (record.sealedAt?.toISOString() ?? null),
    },
  };
}

/** Why a legacy (spec_version 1) row is not a run the view model can show. */
export const LEGACY_RUN = UNRECORDED_GAP.operatorId;

export function toLedgerRunRow(record: LedgerRunRecord): Read<RunRow> {
  if (record.run.specVersion !== 2)
    return notBacked(LEGACY_RUN.milestone, LEGACY_RUN.gap);
  return finish(RunRow, ledgerRowDraft(record));
}

/**
 * The Run header for a ledger run. `token_usage` step sums carry no cache token
 * classes, so the view model's required cache hit rate is not recorded for any
 * ledger run until `cost.run_totals` (G3): this answers `not_backed` naming the
 * earliest missing field, and becomes a value once the contract lets the rate be
 * null (promoted) or the rollup lands.
 */
export function toLedgerRunDetail(record: LedgerRunRecord): Read<RunDetail> {
  if (record.run.specVersion !== 2)
    return notBacked(LEGACY_RUN.milestone, LEGACY_RUN.gap);
  const row = ledgerRowDraft(record);
  if (!row.ok && "invalid" in row) return readError(RUN_RECORD_INVALID, 500);
  const unrecorded: Unrecorded[] = row.ok ? [] : [...row.unrecorded];
  if (!(record.usage?.model || record.rollup.lastModel))
    unrecorded.push("model");
  unrecorded.push("cacheHitRate");
  return notBackedFor(unrecorded);
}

// ---- Frames from the ledger's event log ---------------------------------------------

/**
 * Ledger event type → spec frame kind. Only types whose meaning the frame
 * vocabulary carries are mapped; the rest (checkout, change, verification,
 * provider publish, terminal, the approval DECISION) have no FrameKind yet and
 * are listed for promotion into `contracts/runs.ts`.
 */
export const LEDGER_FRAME_KINDS: Readonly<Record<string, FrameKind>> = {
  "admission.run_admitted": "agent.start",
  "context.frames_selected": "context.assembled",
  // The ledger records a model call once it completes: the response side.
  "model.call_completed": "model.response",
  "tool.call_completed": "tool.result",
};

export const UNMAPPED_LEDGER_EVENT_TYPES = [
  "checkout.completed",
  "checkout.unavailable",
  "tool.approval_recorded",
  "change.recorded",
  "verification.completed",
  "provider_publish.commit_created",
  "provider_publish.pull_request_opened",
  "terminal.attempt_terminated",
] as const;

function field(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A short, machine-derived label for the frame list: identifiers from the
 * inline receipt metadata (never prose, which lives in the message catalog).
 * An encrypted payload shows its event type and nothing it cannot read.
 */
export function ledgerFrameSummary(event: AttemptEventReadRecord): string {
  const p = event.payload;
  switch (event.eventType) {
    case "admission.run_admitted": {
      const name = field(p, "engine_name");
      const version = field(p, "engine_version");
      return name && version ? `${name}@${version}` : event.eventType;
    }
    case "context.frames_selected": {
      const frames = field(p, "frame_count");
      return frames ? `frames=${frames}` : event.eventType;
    }
    case "model.call_completed": {
      const provider = field(p, "provider");
      const model = field(p, "model");
      return provider && model ? `${provider}/${model}` : event.eventType;
    }
    case "tool.call_completed": {
      const capability = field(p, "capability_name");
      const outcome = field(p, "outcome");
      return capability && outcome
        ? `${capability} ${outcome}`
        : event.eventType;
    }
    default:
      return event.eventType;
  }
}

/**
 * One ledger event as a frame, or null when its type has no frame kind. The
 * frame keeps the event's own `run_seq`, so a skipped event shows as a seq jump
 * rather than a renumbered sequence. `hash` is the event's own digest; ledger
 * events are chained through the attempt's stream-digest fold, not a per-event
 * previous-hash link, so `prevHash` is not recorded. Per-frame tier and cost
 * are not recorded by the ledger.
 */
export function toLedgerFrame(event: AttemptEventReadRecord): Frame | null {
  const kind = LEDGER_FRAME_KINDS[event.eventType];
  if (!kind) return null;
  return {
    seq: event.runSeq,
    kind,
    ts: event.observedAt.toISOString(),
    tier: null,
    cost: null,
    summary: ledgerFrameSummary(event),
    hash: event.eventDigest,
    prevHash: null,
  };
}

// ---- Wrapped agents (`tacho.sessions`) ------------------------------------------------

type TachoSessionRow = typeof schema.tachoSessions.$inferSelect;

/** The `tacho.sessions` columns a run is built from. */
export type TachoSessionColumns = Pick<
  TachoSessionRow,
  | "publicId"
  | "agentKey"
  | "outcome"
  | "numTurns"
  | "numModelCalls"
  | "numToolCalls"
  | "seqCount"
  | "totalCostMicros"
  | "hasUnknownModelCost"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreationTokens"
  | "enforcementTier"
  | "replayGrade"
  | "modelInitial"
  | "modelFinal"
  | "startedAt"
  | "sealedAt"
>;

export type TachoSessionRecord = {
  session: TachoSessionColumns;
  workspaceSlug: string;
  /** `iam.principals.public_id` for `initiating_principal_id`. */
  operatorPublicId: string | null;
};

/**
 * Session outcome → RunStatus. `aborted` is a stop the operator or harness
 * forced (halted); every other terminal outcome was sealed at `agent_stop`.
 */
export function tachoRunStatus(outcome: string): RunStatus {
  switch (outcome) {
    case "running":
      return "live";
    case "aborted":
      return "halted";
    default:
      return "sealed";
  }
}

/**
 * The session's cost so far, reported by the harness and priced by the
 * collector: client-attested (spec §8.3). Not recorded when the collector saw a
 * model it could not price, or saw tokens but no cost at all, since the total
 * would read lower than what was spent.
 */
export function tachoCost(session: TachoSessionColumns): Money | null {
  if (session.hasUnknownModelCost === true) return null;
  const tokens = session.inputTokens + session.outputTokens;
  if (session.totalCostMicros === 0 && tokens > 0) return null;
  return {
    micros: microsString(session.totalCostMicros),
    currency: USD,
    basis: "client_attested",
  };
}

/** Cache reads over every prompt token class; not recorded before a model call. */
export function tachoCacheHitRate(session: TachoSessionColumns): number | null {
  const prompt =
    session.inputTokens + session.cacheReadTokens + session.cacheCreationTokens;
  if (prompt <= 0) return null;
  return session.cacheReadTokens / prompt;
}

function tachoRowDraft(record: TachoSessionRecord): Mapped<RunRow> {
  const { session } = record;
  const operatorId = record.operatorPublicId;
  const agentKeyRecorded = AgentKey.safeParse(session.agentKey).success;
  const cost = tachoCost(session);
  if (operatorId === null || !agentKeyRecorded || cost === null) {
    const unrecorded: Unrecorded[] = [];
    if (operatorId === null) unrecorded.push("operatorId");
    if (!agentKeyRecorded) unrecorded.push("agentKey");
    if (cost === null) unrecorded.push("cost");
    return { ok: false, unrecorded };
  }
  return {
    ok: true,
    value: {
      id: session.publicId,
      // G14. The harness's own session title is not the run name.
      name: null,
      agentKey: session.agentKey,
      operatorId,
      workspaceSlug: record.workspaceSlug,
      status: tachoRunStatus(session.outcome),
      turns: session.numTurns,
      steps: session.numModelCalls + session.numToolCalls,
      frames: session.seqCount,
      cost,
      tier: enumOrNull(EnforcementTier, session.enforcementTier),
      grade: enumOrNull(ReplayGrade, session.replayGrade),
      // G7: no witness verdicts are recorded.
      verdict: null,
      taskRef: null,
      startedAt: session.startedAt.toISOString(),
      sealedAt: session.sealedAt?.toISOString() ?? null,
    },
  };
}

export function toTachoRunRow(record: TachoSessionRecord): Read<RunRow> {
  return finish(RunRow, tachoRowDraft(record));
}

export function toTachoRunDetail(
  record: TachoSessionRecord,
  /** Paths the session wrote, edited or deleted (`tacho.session_files`), by first seq. */
  touchedPaths: readonly string[],
): Read<RunDetail> {
  const row = tachoRowDraft(record);
  if (!row.ok && "invalid" in row) return readError(RUN_RECORD_INVALID, 500);
  const model = record.session.modelFinal ?? record.session.modelInitial;
  const cacheHitRate = tachoCacheHitRate(record.session);
  if (!row.ok || model === null || cacheHitRate === null) {
    const unrecorded: Unrecorded[] = row.ok ? [] : [...row.unrecorded];
    if (model === null) unrecorded.push("model");
    if (cacheHitRate === null) unrecorded.push("cacheHitRate");
    return notBackedFor(unrecorded);
  }
  return finish(RunDetail, {
    ok: true,
    value: {
      ...row.value,
      model,
      cacheHitRate,
      // G7: proven spend needs the witness flip.
      provenSpend: null,
      productiveRatio: null,
      // G14: no light-tier summary is written.
      summary: null,
      touched: [...touchedPaths],
    },
  });
}

// ---- Fleet list paging ----------------------------------------------------------------

/** Where a page ended: the last row's start instant and public id. */
export type RunCursor = { at: string; id: string };

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString(
    "base64url",
  );
}

/** Null for anything that is not a cursor this adapter wrote. */
export function decodeRunCursor(raw: string): RunCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      Number.isNaN(Date.parse(value[0])) ||
      !/^[a-z]+_[A-Za-z0-9]+$/.test(value[1])
    )
      return null;
    return { at: value[0], id: value[1] };
  } catch {
    // Not base64url JSON: a hand-edited or foreign cursor, answered as invalid.
    return null;
  }
}

/** Newest first; ties break on public id, descending, as both queries order. */
export function compareRunsNewestFirst(
  a: { startedAt: string; id: string },
  b: { startedAt: string; id: string },
): number {
  const at = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (at !== 0) return at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** A run in a source page, before it is mapped: enough to order and page it. */
export type PageItem = { startedAt: string; id: string };

/**
 * Merge newest-first source pages into one page of `limit` items. Each source
 * was read with `limit + 1` and trimmed, so more items exist when a source
 * overflowed or the merge left items over. Paging on the raw items, before
 * mapping, means a run past the page end never decides the page's state.
 */
export function mergeNewestFirst<T extends PageItem>(
  sources: readonly { items: readonly T[]; overflowed: boolean }[],
  limit: number,
): { items: T[]; next: string | null } {
  const merged = sources.flatMap((s) => s.items).sort(compareRunsNewestFirst);
  const items = merged.slice(0, limit);
  const more = merged.length > limit || sources.some((s) => s.overflowed);
  const last = items.at(-1);
  return {
    items,
    next:
      more && last
        ? encodeRunCursor({ at: last.startedAt, id: last.id })
        : null,
  };
}
