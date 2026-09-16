// `list_runs`: Fleet's runs table, read from the two stores that record runs.
//
//   arun_…  the run evidence ledger: `agent.agent_runs` (V2 rows only; a legacy
//           V1 row carries no run identity), counts folded from
//           `agent.agent_run_events`, the latest seal from
//           `agent.agent_run_attempt_seals`.
//   tse_…   wrapped agents in `tacho.sessions`, root sessions only (a subagent
//           chain is part of its parent's run).
//
// Cost, basis and the witness verdict for both come from the run's
// `cost.run_totals` row (ADR-060, ADR-064), which the rollup job rebuilds from
// the run's frames after its seal; a run with no row yet answers `cost: null`
// and `verdict: null`. Nothing here reads ClickHouse.
//
// An API-key caller is shown no witness run (ADR-064): a worker holds API keys,
// and a run a verdict names as its witness run would show it the witness.
//
// The kernel enters the tenant scope before this handler runs, so every
// Postgres read goes through withTenantDb, whose RLS is the tenant filter. The
// queries ALSO name org_id and workspace_id: a local stack runs with the RLS
// bypass on, and a run from another workspace must still stay out of the list.
//
// Every field the store may not have recorded maps to null, never to a
// substitute.
//
// The in-app agent's turns are runs too (MC spec §14.1), admitted on the
// `chat` and `api-chat` surfaces by `openAssistantRun` in @oxagen/agent. The
// assistant is Oxagen's: the customer talks to it and never owns or manages
// it, so its runs are recorded and never listed as the customer's (Mockups
// 71bc546; apps/app/ARCHITECTURE.md §1.2). The page query excludes those two
// surfaces; `ledgerIdentityQuery` does not, because the flyout's per-turn run
// link opens the run through `get_run`.
//
// Ported from apps/app/src/data/adapters/live/runs.ts and mappers/runs.ts at
// 27b9d2520 (ARCHITECTURE.md §7.2), minus the view-model concerns that stay
// in the app.
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  IN_APP_AGENT_SURFACES,
  type RunItem,
  runList,
  type RunListOutput,
} from "@oxagen/oxagen/contracts/run.list";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { isReplayGrade } from "@oxagen/tacho";
import { PROOF_VERDICTS } from "@oxagen/run-evidence";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

/** The tenant a read is fenced to: the invoking context's org and workspace. */
export type RunScope = { orgId: string; workspaceId: string };

export function runScope(ctx: CapabilityContext): RunScope {
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
}

// ---- Cursor -------------------------------------------------------------------------

/** Where a page ended: the last row's start instant and public id. */
export type RunCursor = { at: string; id: string };

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString(
    "base64url",
  );
}

/** Null for anything that is not a cursor this handler wrote. */
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
      !/^(arun|tse)_[0-9a-z]+$/.test(value[1])
    )
      return null;
    return { at: value[0], id: value[1] };
  } catch {
    // Not base64url JSON: a hand-edited or foreign cursor.
    return null;
  }
}

export function invalidCursor(capability: string): CapabilityError {
  return new CapabilityError(capability, "invalid_input", "invalid_cursor");
}

// ---- Queries -------------------------------------------------------------------------

/** What a query needs from a transaction: the select builder. */
export type QueryDb = Pick<Tx, "select" | "selectDistinctOn">;

const runs = schema.agentRuns;
const events = schema.agentRunEvents;
const seals = schema.agentRunAttemptSeals;
const sessions = schema.tachoSessions;
const verdicts = schema.verdicts;

/** Millisecond precision, so a cursor built from a JS Date compares exactly. */
const ms = (column: SQL | typeof sessions.startedAt) =>
  sql`date_trunc('milliseconds', ${column})`;

const ledgerStartedAt = sql`coalesce(${runs.startedAt}, ${runs.createdAt})`;

/**
 * A public id compared byte-wise. The page merge breaks ties in JavaScript
 * (code-unit order); a locale collation could order `_` differently and skip or
 * repeat a run that shares its millisecond with the cursor.
 */
const byteOrder = (publicId: typeof runs.publicId | typeof sessions.publicId) =>
  sql`${publicId} collate "C"`;

/** Newest first from the cursor, ties broken on public id. */
function beforeCursor(
  at: SQL,
  publicId: typeof runs.publicId | typeof sessions.publicId,
  cursor: RunCursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const instant = new Date(cursor.at);
  return or(
    lt(ms(at), instant),
    and(eq(ms(at), instant), sql`${byteOrder(publicId)} < ${cursor.id}`),
  );
}

export type PageQuery = {
  cursor: RunCursor | null;
  limit: number;
  /** Leave out every run a verdict names as its witness run: true for an API-key caller. */
  withoutWitnessRuns: boolean;
};

/** No verdict in the run's workspace names it as a witness run, when the page asks. */
function notWitnessRun(
  q: PageQuery,
  run: {
    orgId: typeof runs.orgId | typeof sessions.orgId;
    workspaceId: typeof runs.workspaceId | typeof sessions.workspaceId;
    publicId: typeof runs.publicId | typeof sessions.publicId;
  },
): SQL | undefined {
  if (!q.withoutWitnessRuns) return undefined;
  return sql`not exists (select 1 from ${verdicts} where ${verdicts.orgId} = ${run.orgId} and ${verdicts.workspaceId} = ${run.workspaceId} and ${verdicts.witnessRunId} = ${run.publicId}::text)`;
}

const ledgerColumns = {
  run: {
    runId: runs.id,
    publicId: runs.publicId,
    status: runs.status,
    createdAt: runs.createdAt,
    startedAt: runs.startedAt,
    name: runs.name,
    summary: runs.summary,
    summaryGeneratedAt: runs.summaryGeneratedAt,
    summaryModel: runs.summaryModel,
  },
  identity: {
    orgNamespace: schema.organizations.namespace,
    workspaceNamespace: schema.workspaces.namespace,
    agentSlug: schema.agents.slug,
    operatorPublicId: schema.principals.publicId,
    goal: sql<string | null>`${runs.spec}->>'goal'`,
  },
};

function ledgerRunsSelect(db: QueryDb) {
  return db
    .select(ledgerColumns)
    .from(runs)
    .innerJoin(
      schema.workspaces,
      and(
        eq(schema.workspaces.id, runs.workspaceId),
        eq(schema.workspaces.orgId, runs.orgId),
      ),
    )
    .innerJoin(schema.organizations, eq(schema.organizations.id, runs.orgId))
    .leftJoin(
      schema.agents,
      and(
        eq(schema.agents.id, runs.agentId),
        eq(schema.agents.workspaceId, runs.workspaceId),
      ),
    )
    .leftJoin(
      schema.principals,
      and(
        eq(schema.principals.id, runs.initiatingPrincipalId),
        eq(schema.principals.orgId, runs.orgId),
      ),
    );
}

/** V2 ledger runs in the workspace, newest first, the in-app agent's excluded. */
export function ledgerPageQuery(db: QueryDb, scope: RunScope, q: PageQuery) {
  return ledgerRunsSelect(db)
    .where(
      and(
        eq(runs.orgId, scope.orgId),
        eq(runs.workspaceId, scope.workspaceId),
        eq(runs.specVersion, 2),
        notInArray(runs.surface, [...IN_APP_AGENT_SURFACES]),
        beforeCursor(ledgerStartedAt, runs.publicId, q.cursor),
        notWitnessRun(q, runs),
      ),
    )
    .orderBy(desc(ms(ledgerStartedAt)), desc(byteOrder(runs.publicId)))
    .limit(q.limit + 1);
}

/** One V2 run by its uuid, only when it belongs to the scope's workspace. */
export function ledgerIdentityQuery(
  db: QueryDb,
  scope: RunScope,
  runId: string,
) {
  return ledgerRunsSelect(db)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.orgId, scope.orgId),
        eq(runs.workspaceId, scope.workspaceId),
        eq(runs.specVersion, 2),
      ),
    )
    .limit(1);
}

const MODEL_CALL = "model.call_completed";
const TOOL_CALL = "tool.call_completed";

/** Frame, step and turn counts folded from the V2 event log, per run. */
export function ledgerRollupQuery(
  db: QueryDb,
  scope: RunScope,
  runIds: readonly string[],
) {
  return db
    .select({
      runId: events.runId,
      frames: sql<number>`count(*)::int`.mapWith(Number),
      modelCalls:
        sql<number>`(count(*) filter (where ${events.eventType} = ${MODEL_CALL}))::int`.mapWith(
          Number,
        ),
      toolCalls:
        sql<number>`(count(*) filter (where ${events.eventType} = ${TOOL_CALL}))::int`.mapWith(
          Number,
        ),
      turnIndexes:
        sql<number>`(count(distinct ${events.payloadInline}->>'turn_index') filter (where ${events.eventType} = ${MODEL_CALL}))::int`.mapWith(
          Number,
        ),
      opaqueModelCalls:
        sql<number>`(count(*) filter (where ${events.eventType} = ${MODEL_CALL} and ${events.payloadInline} is null))::int`.mapWith(
          Number,
        ),
    })
    .from(events)
    .where(
      and(
        eq(events.eventRecordVersion, 2),
        eq(events.orgId, scope.orgId),
        eq(events.workspaceId, scope.workspaceId),
        inArray(events.runId, [...runIds]),
      ),
    )
    .groupBy(events.runId);
}

/**
 * The rollup of a run's compacted attempts (spec §13.3; ADR-058): attempts
 * whose hot frames compaction removed keep their counts on the seal. Summed
 * per run over the seals with no rows left in the event log, so a run that is
 * half compacted counts every frame exactly once when this is added to
 * `ledgerRollupQuery`. `opaqueTurns` is true when any such seal could not
 * count turns (an encrypted model call hid its turn index).
 */
export function ledgerCompactedRollupQuery(
  db: QueryDb,
  scope: RunScope,
  runIds: readonly string[],
) {
  return db
    .select({
      runId: seals.runId,
      frames: sql<number>`coalesce(sum(${seals.eventCount}), 0)::int`.mapWith(
        Number,
      ),
      modelCalls:
        sql<number>`coalesce(sum(${seals.modelCalls}), 0)::int`.mapWith(Number),
      toolCalls: sql<number>`coalesce(sum(${seals.toolCalls}), 0)::int`.mapWith(
        Number,
      ),
      turns: sql<number>`coalesce(sum(${seals.turns}), 0)::int`.mapWith(Number),
      opaqueTurns: sql<boolean>`bool_or(${seals.turns} is null)`,
    })
    .from(seals)
    .where(
      and(
        eq(seals.orgId, scope.orgId),
        eq(seals.workspaceId, scope.workspaceId),
        inArray(seals.runId, [...runIds]),
        sql`${seals.archiveSegmentRef} is not null`,
        sql`not exists (select 1 from ${events} where ${events.attemptId} = ${seals.attemptId})`,
      ),
    )
    .groupBy(seals.runId);
}

/** The event-log rollup plus the compacted seals' rollup, per run. */
export function addCompactedRollup(
  hot: LedgerEventRollup | undefined,
  compacted:
    | {
        frames: number;
        modelCalls: number;
        toolCalls: number;
        turns: number;
        opaqueTurns: boolean;
      }
    | undefined,
): LedgerEventRollup | undefined {
  if (!compacted) return hot;
  const base = hot ?? EMPTY_ROLLUP;
  return {
    frames: base.frames + compacted.frames,
    modelCalls: base.modelCalls + compacted.modelCalls,
    toolCalls: base.toolCalls + compacted.toolCalls,
    turnIndexes: base.turnIndexes + compacted.turns,
    opaqueModelCalls: base.opaqueModelCalls + (compacted.opaqueTurns ? 1 : 0),
  };
}

/**
 * The latest attempt seal per run: when it sealed, the grade it recorded and
 * the gaps the grade was computed from (ADR-058). One row per run.
 */
export function ledgerSealQuery(
  db: QueryDb,
  scope: RunScope,
  runIds: readonly string[],
) {
  return db
    .selectDistinctOn([seals.runId], {
      runId: seals.runId,
      attemptId: seals.attemptId,
      sealedAt: seals.sealedAt,
      replayGrade: seals.replayGrade,
      completenessGaps: seals.completenessGaps,
      finalRunSeq: sql<string | null>`${seals.finalRunSeq}::text`,
      eventCount: seals.eventCount,
      merkleRoot: seals.merkleRoot,
      archiveSegmentRef: seals.archiveSegmentRef,
    })
    .from(seals)
    .where(
      and(
        eq(seals.orgId, scope.orgId),
        eq(seals.workspaceId, scope.workspaceId),
        inArray(seals.runId, [...runIds]),
      ),
    )
    .orderBy(seals.runId, desc(seals.sealedAt));
}

const tachoColumns = {
  session: {
    publicId: sessions.publicId,
    sessionUuid: sessions.sessionUuid,
    agentKey: sessions.agentKey,
    outcome: sessions.outcome,
    numTurns: sessions.numTurns,
    numModelCalls: sessions.numModelCalls,
    numToolCalls: sessions.numToolCalls,
    seqCount: sessions.seqCount,
    startedAt: sessions.startedAt,
    sealedAt: sessions.sealedAt,
    replayGrade: sessions.replayGrade,
    completenessGaps: sessions.completenessGaps,
    enforcementTier: sessions.enforcementTier,
    name: sessions.name,
    summary: sessions.summary,
    summaryGeneratedAt: sessions.summaryGeneratedAt,
    summaryModel: sessions.summaryModel,
  },
  operatorPublicId: schema.principals.publicId,
};

function tachoSessionsSelect(db: QueryDb) {
  return db
    .select(tachoColumns)
    .from(sessions)
    .leftJoin(
      schema.principals,
      and(
        eq(schema.principals.id, sessions.initiatingPrincipalId),
        eq(schema.principals.orgId, sessions.orgId),
      ),
    );
}

/** Root wrapped-agent sessions in the workspace, newest first. */
export function tachoPageQuery(db: QueryDb, scope: RunScope, q: PageQuery) {
  return tachoSessionsSelect(db)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        isNull(sessions.parentSessionUuid),
        beforeCursor(sql`${sessions.startedAt}`, sessions.publicId, q.cursor),
        notWitnessRun(q, sessions),
      ),
    )
    .orderBy(desc(ms(sessions.startedAt)), desc(byteOrder(sessions.publicId)))
    .limit(q.limit + 1);
}

/** One root session by public id, only in the scope's workspace. */
export function tachoSessionQuery(
  db: QueryDb,
  scope: RunScope,
  publicId: string,
) {
  return tachoSessionsSelect(db)
    .where(
      and(
        eq(sessions.publicId, publicId),
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        isNull(sessions.parentSessionUuid),
      ),
    )
    .limit(1);
}

// ---- Records and mapping -------------------------------------------------------------

/** The generated summary columns a run row carries (`summarize_run`, G14). */
type GeneratedSummaryColumns = {
  name: string | null;
  summary: string | null;
  summaryGeneratedAt: Date | null;
  summaryModel: string | null;
};

type LedgerRunCore = GeneratedSummaryColumns & {
  runId: string;
  publicId: string;
  /** `agent_runs.status` (CHECK: pending, running, completed, failed, cancelled). */
  status: string;
  createdAt: Date;
  startedAt: Date | null;
};

export type LedgerRunIdentity = {
  orgNamespace: string | null;
  workspaceNamespace: string | null;
  agentSlug: string | null;
  /** `iam.principals.public_id` for `agent_runs.initiating_principal_id`. */
  operatorPublicId: string | null;
  /** `agent_runs.spec->>'goal'`: the task a run was admitted for. */
  goal: string | null;
};

export type LedgerRunRow = { run: LedgerRunCore; identity: LedgerRunIdentity };

/**
 * Counts folded from a run's V2 events. A step is one model call or one tool
 * call; a turn is a distinct `turn_index` among model calls, which travels
 * only in an inline payload, so an encrypted model call hides its turn.
 */
export type LedgerEventRollup = {
  frames: number;
  modelCalls: number;
  toolCalls: number;
  turnIndexes: number;
  opaqueModelCalls: number;
};

/** The durable event log is the authority: no events means zero of each. */
export const EMPTY_ROLLUP: LedgerEventRollup = {
  frames: 0,
  modelCalls: 0,
  toolCalls: 0,
  turnIndexes: 0,
  opaqueModelCalls: 0,
};

/** The latest seal of a run, as `ledgerSealQuery` reads it. */
export type LedgerSeal = {
  runId: string;
  attemptId: string;
  sealedAt: Date;
  /** Null on a seal written before the recorder graded. */
  replayGrade: string | null;
  completenessGaps: unknown;
  finalRunSeq: string | null;
  eventCount: number;
  merkleRoot: string | null;
  archiveSegmentRef: string | null;
};

export type LedgerRunRecord = LedgerRunRow & {
  rollup: LedgerEventRollup;
  /** The latest attempt seal; null while the run is open or none was recorded. */
  seal: LedgerSeal | null;
};

/** What a `cost.run_totals` row says about a run's spend. */
export type RunCost = {
  costMicros: bigint;
  currency: string;
  costBasis: NonNullable<RunItem["cost"]>["basis"];
};

/** What a `cost.run_totals` row says about a run: its spend and its witness verdict. */
type RunRollup = { cost: RunCost | null; verdict: RunItem["verdict"] };

export type TachoSessionColumns = GeneratedSummaryColumns & {
  publicId: string;
  sessionUuid: string;
  agentKey: string;
  outcome: string;
  numTurns: number;
  numModelCalls: number;
  numToolCalls: number;
  seqCount: number;
  startedAt: Date;
  sealedAt: Date | null;
  /** Written by the seal at `agent_stop`; null while the session is open. */
  replayGrade: string | null;
  completenessGaps: unknown;
  enforcementTier: string;
};

export type TachoSessionRow = {
  session: TachoSessionColumns;
  /** `iam.principals.public_id` for `initiating_principal_id`. */
  operatorPublicId: string | null;
};

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

const LEDGER_RUN_STATUS: Readonly<Record<string, RunItem["status"]>> = {
  pending: "live",
  running: "live",
  completed: "sealed",
  failed: "sealed",
  cancelled: "halted",
};

/**
 * `pending` (admitted, no attempt yet) and `running` are both open runs. Every
 * terminal outcome is sealed except a cancel, which is a halt. A word outside
 * the column's CHECK is a broken row, and the read fails rather than guesses.
 */
export function ledgerRunStatus(status: string): RunItem["status"] {
  const mapped = Object.hasOwn(LEDGER_RUN_STATUS, status)
    ? LEDGER_RUN_STATUS[status]
    : undefined;
  if (!mapped)
    throw new RangeError(`ledger run status outside the CHECK: ${status}`);
  return mapped;
}

/**
 * The recorded grade, or null: a seal the recorder never graded, an open run,
 * or a word outside the ladder (a broken row reads as ungraded, never as a
 * stronger word). Nothing computes a grade on read.
 */
function recordedGrade(grade: string | null): RunItem["replayGrade"] {
  return isReplayGrade(grade) ? grade : null;
}

/** The gaps column as a string list; anything else is no gaps. */
export function recordedGaps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** The generated summary, present only when all three columns were set together. */
function generatedSummary(
  columns: GeneratedSummaryColumns,
): RunItem["summary"] {
  if (
    columns.summary === null ||
    columns.summaryGeneratedAt === null ||
    columns.summaryModel === null
  )
    return null;
  return {
    text: columns.summary,
    generatedAt: columns.summaryGeneratedAt.toISOString(),
    model: columns.summaryModel,
  };
}

/** Integer micro-units as the wire's decimal string; refuses a float or NaN. */
export function microsString(micros: number): string {
  if (!Number.isSafeInteger(micros))
    throw new RangeError(
      `cost micros must be a safe integer: ${String(micros)}`,
    );
  return String(micros);
}

/**
 * The run's cost as its rollup row records it. No row yet — the run is open,
 * or the rollup has not covered its seal — means no cost, never zero.
 */
function rollupCost(rollup: RunRollup | undefined): RunItem["cost"] {
  const row = rollup?.cost;
  if (!row) return null;
  return {
    micros: row.costMicros.toString(),
    currency: row.currency,
    basis: row.costBasis,
  };
}

export function toLedgerRunItem(
  record: LedgerRunRecord,
  totals: RunRollup | undefined,
): RunItem {
  const { run, identity, rollup } = record;
  const status = ledgerRunStatus(run.status);
  return {
    id: run.publicId,
    source: "ledger",
    agentKey: composeAgentKey(
      identity.orgNamespace,
      identity.workspaceNamespace,
      identity.agentSlug,
    ),
    operatorId: identity.operatorPublicId,
    status,
    turns: rollup.opaqueModelCalls === 0 ? rollup.turnIndexes : null,
    steps: rollup.modelCalls + rollup.toolCalls,
    frames: rollup.frames,
    cost: rollupCost(totals),
    taskRef: identity.goal,
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    sealedAt:
      status === "live" ? null : (record.seal?.sealedAt.toISOString() ?? null),
    replayGrade:
      status === "live"
        ? null
        : recordedGrade(record.seal?.replayGrade ?? null),
    verdict: totals?.verdict ?? null,
    name: run.name,
    summary: generatedSummary(run),
  };
}

/**
 * Session outcome → status. `aborted` is a stop the operator or harness
 * forced; every other terminal outcome was sealed at `agent_stop`.
 */
export function tachoRunStatus(outcome: string): RunItem["status"] {
  switch (outcome) {
    case "running":
      return "live";
    case "aborted":
      return "halted";
    default:
      return "sealed";
  }
}

export function toTachoRunItem(
  row: TachoSessionRow,
  totals: RunRollup | undefined,
): RunItem {
  const { session } = row;
  return {
    id: session.publicId,
    source: "tacho",
    agentKey: session.agentKey,
    operatorId: row.operatorPublicId,
    status: tachoRunStatus(session.outcome),
    turns: session.numTurns,
    steps: session.numModelCalls + session.numToolCalls,
    frames: session.seqCount,
    cost: rollupCost(totals),
    taskRef: null,
    startedAt: session.startedAt.toISOString(),
    sealedAt: session.sealedAt?.toISOString() ?? null,
    replayGrade: recordedGrade(session.replayGrade),
    verdict: totals?.verdict ?? null,
    name: session.name,
    summary: generatedSummary(session),
  };
}

// ---- Paging ---------------------------------------------------------------------------

/** A run in a source page, before it is mapped: enough to order and page it. */
type PageItem = { startedAt: string; id: string };

/** Newest first; ties break on public id, descending, as both queries order. */
function compareNewestFirst(a: PageItem, b: PageItem): number {
  const at = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (at !== 0) return at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Merge newest-first source pages into one page of `limit` items. Each source
 * was read with `limit + 1` and trimmed, so more items exist when a source
 * overflowed or the merge left items over.
 */
export function mergeNewestFirst<T extends PageItem>(
  sources: readonly { items: readonly T[]; overflowed: boolean }[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const merged = sources.flatMap((s) => s.items).sort(compareNewestFirst);
  const items = merged.slice(0, limit);
  const more = merged.length > limit || sources.some((s) => s.overflowed);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      more && last
        ? encodeRunCursor({ at: last.startedAt, id: last.id })
        : null,
  };
}

// ---- Dependencies ---------------------------------------------------------------------

/** The reads the handlers make. Each runs inside the kernel's tenant scope. */
export type RunQueries = {
  ledgerPage: (scope: RunScope, q: PageQuery) => Promise<LedgerRunRow[]>;
  ledgerIdentity: (
    scope: RunScope,
    runId: string,
  ) => Promise<LedgerRunRow | null>;
  ledgerRollups: (
    scope: RunScope,
    runIds: readonly string[],
  ) => Promise<Map<string, LedgerEventRollup>>;
  ledgerSeals: (
    scope: RunScope,
    runIds: readonly string[],
  ) => Promise<Map<string, LedgerSeal>>;
  tachoPage: (scope: RunScope, q: PageQuery) => Promise<TachoSessionRow[]>;
  tachoSession: (
    scope: RunScope,
    publicId: string,
  ) => Promise<TachoSessionRow | null>;
};

/** The `cost.run_totals` rows for a page of runs, by public id; a run with no row is absent. */
export type ReadRunRollups = (
  scope: RunScope,
  runIds: readonly string[],
) => Promise<Map<string, RunRollup>>;

const COST_BASES = new Set([
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
]);

/**
 * The verdict the rollup recorded, or null: no row, or `none` (no witness
 * reported). A word outside the CHECK is a broken row and the read fails.
 */
function recordedVerdict(word: string | null): RunItem["verdict"] {
  if (word === null || word === "none") return null;
  const verdict = PROOF_VERDICTS.find((known) => known === word);
  if (!verdict) throw new RangeError(`verdict outside the CHECK: ${word}`);
  return verdict;
}

export const postgresReadRunRollups: ReadRunRollups = async (scope, runIds) => {
  if (runIds.length === 0) return new Map();
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        runId: schema.runTotals.runId,
        costMicros: schema.runTotals.costMicros,
        currency: schema.runTotals.currency,
        costBasis: schema.runTotals.costBasis,
        verdict: schema.runTotals.verdict,
      })
      .from(schema.runTotals)
      .where(
        and(
          eq(schema.runTotals.orgId, scope.orgId),
          eq(schema.runTotals.workspaceId, scope.workspaceId),
          inArray(schema.runTotals.runId, [...runIds]),
        ),
      ),
  );
  const out = new Map<string, RunRollup>();
  for (const r of rows) {
    if (r.costBasis !== null && !COST_BASES.has(r.costBasis))
      throw new RangeError(`cost basis outside the CHECK: ${r.costBasis}`);
    // A row whose frames priced nothing carries null cost and basis: no cost.
    const cost =
      r.costMicros === null || r.costBasis === null
        ? null
        : {
            costMicros: r.costMicros,
            currency: r.currency,
            costBasis: r.costBasis as RunCost["costBasis"],
          };
    out.set(r.runId, { cost, verdict: recordedVerdict(r.verdict) });
  }
  return out;
};

export const postgresRunQueries: RunQueries = {
  ledgerPage: (scope, q) => withTenantDb((tx) => ledgerPageQuery(tx, scope, q)),
  ledgerIdentity: async (scope, runId) => {
    const rows = await withTenantDb((tx) =>
      ledgerIdentityQuery(tx, scope, runId),
    );
    return rows[0] ?? null;
  },
  ledgerRollups: async (scope, runIds) => {
    if (runIds.length === 0) return new Map();
    const [rows, compacted] = await withTenantDb(async (tx) => [
      await ledgerRollupQuery(tx, scope, runIds),
      await ledgerCompactedRollupQuery(tx, scope, runIds),
    ]);
    const hot = new Map(rows.map(({ runId, ...rollup }) => [runId, rollup]));
    const out = new Map<string, LedgerEventRollup>();
    for (const runId of runIds) {
      const rollup = addCompactedRollup(
        hot.get(runId),
        compacted.find((c) => c.runId === runId),
      );
      if (rollup) out.set(runId, rollup);
    }
    return out;
  },
  ledgerSeals: async (scope, runIds) => {
    if (runIds.length === 0) return new Map();
    const rows = await withTenantDb((tx) => ledgerSealQuery(tx, scope, runIds));
    return new Map(rows.map((r) => [r.runId, r]));
  },
  tachoPage: (scope, q) => withTenantDb((tx) => tachoPageQuery(tx, scope, q)),
  tachoSession: async (scope, publicId) => {
    const rows = await withTenantDb((tx) =>
      tachoSessionQuery(tx, scope, publicId),
    );
    return rows[0] ?? null;
  },
};

/** Seals and event rollups for a set of ledger runs, in parallel. */
export async function ledgerEnrichment(
  deps: { queries: Pick<RunQueries, "ledgerRollups" | "ledgerSeals"> },
  scope: RunScope,
  runIds: readonly string[],
) {
  const [rollups, sealed] = await Promise.all([
    deps.queries.ledgerRollups(scope, runIds),
    deps.queries.ledgerSeals(scope, runIds),
  ]);
  return (row: LedgerRunRow): LedgerRunRecord => ({
    ...row,
    rollup: rollups.get(row.run.runId) ?? EMPTY_ROLLUP,
    seal: sealed.get(row.run.runId) ?? null,
  });
}

// ---- The handler -----------------------------------------------------------------------

export type RunListDeps = {
  queries: RunQueries;
  readRunRollups: ReadRunRollups;
};

type FleetItem =
  | { kind: "ledger"; id: string; startedAt: string; row: LedgerRunRow }
  | { kind: "tacho"; id: string; startedAt: string; row: TachoSessionRow };

export function createRunListHandler(
  deps: RunListDeps,
): CapabilityHandler<typeof runList> {
  return async (input, ctx): Promise<RunListOutput> => {
    const scope = runScope(ctx);
    const cursor =
      input.cursor === undefined ? null : decodeRunCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw invalidCursor(runList.name);
    const page = {
      cursor,
      limit: input.limit,
      withoutWitnessRuns: ctx.apiKeyId !== null,
    };

    const [ledger, tacho] = await Promise.all([
      deps.queries.ledgerPage(scope, page),
      deps.queries.tachoPage(scope, page),
    ]);
    const merged = mergeNewestFirst<FleetItem>(
      [
        {
          items: ledger.slice(0, input.limit).map((row) => ({
            kind: "ledger" as const,
            id: row.run.publicId,
            startedAt: (row.run.startedAt ?? row.run.createdAt).toISOString(),
            row,
          })),
          overflowed: ledger.length > input.limit,
        },
        {
          items: tacho.slice(0, input.limit).map((row) => ({
            kind: "tacho" as const,
            id: row.session.publicId,
            startedAt: row.session.startedAt.toISOString(),
            row,
          })),
          overflowed: tacho.length > input.limit,
        },
      ],
      input.limit,
    );

    const [enrich, costs] = await Promise.all([
      ledgerEnrichment(
        deps,
        scope,
        merged.items.flatMap((item) =>
          item.kind === "ledger" ? [item.row.run.runId] : [],
        ),
      ),
      deps.readRunRollups(
        scope,
        merged.items.map((item) => item.id),
      ),
    ]);
    return {
      runs: merged.items.map((item) =>
        item.kind === "ledger"
          ? toLedgerRunItem(enrich(item.row), costs.get(item.id))
          : toTachoRunItem(item.row, costs.get(item.id)),
      ),
      nextCursor: merged.nextCursor,
    };
  };
}

export const runListHandler = createRunListHandler({
  queries: postgresRunQueries,
  readRunRollups: postgresReadRunRollups,
});
