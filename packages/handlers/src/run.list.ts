import { readRunEnrichmentEnabled } from "./lib/run-enrichment";
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
// and `verdict: null`. The one ClickHouse read is the pull requests a wrapped
// session's frames name (`lib/run-list-work.ts`), and a failure there leaves
// the rows up with a warning.
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
  canSummarizeRun,
  commandBlockOf,
  steerBlockOf,
  IN_APP_AGENT_SURFACES,
  type RunItem,
  runList,
  runMachineSnapshotSchema,
  type RunListOutput,
  type RunPullRequest,
} from "@oxagen/oxagen/contracts/run.list";
import {
  hidesWitnessRuns,
  notWitnessRun,
  operatorUserJoin,
  schema,
  type Tx,
  withTenantDb,
} from "@oxagen/database";
import {
  type CompletenessGapKind,
  isCompletenessGapKind,
  isGradeEnforcementTier,
  isReplayGrade,
} from "@oxagen/tacho";
import {
  MODEL_CALL_EVENT_TYPES,
  TOOL_CALL_EVENT_TYPES,
} from "@oxagen/run-ledger";
import { modelFactsOf } from "./lib/model-facts";
import {
  matchesPullRequestFilter,
  postgresRunGitDiffs,
  type ReadRunGitDiffs,
  type ReadRunPullRequests,
  readRunPullRequests,
  runDiffOf,
} from "./lib/run-list-work";
import { logger } from "./logger";
import { PROOF_VERDICTS } from "@oxagen/run-evidence";
import {
  and,
  asc,
  desc,
  eq,
  getTableName,
  inArray,
  isNull,
  lt,
  ne,
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
const hosts = schema.tachoHosts;

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

/**
 * Newest first from the cursor, ties broken on public id.
 *
 * The instant travels as an ISO string cast in SQL. A JS `Date` compared
 * against a raw `sql` fragment has no column to borrow a driver mapping from,
 * so drizzle hands the Date object itself to postgres.js, which rejects it
 * ("The string argument must be of type string or an instance of Buffer") and
 * every page after the first fails.
 */
export function beforeCursor(
  at: SQL,
  publicId: typeof runs.publicId | typeof sessions.publicId,
  cursor: RunCursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const instant = sql`${new Date(cursor.at).toISOString()}::timestamptz`;
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

/**
 * No verdict in the run's workspace names it as a witness run, when the page
 * asks. The predicate itself is `notWitnessRun` in `@oxagen/database`, shared
 * with `search_tools`; this only decides whether this page applies it.
 */
function hideWitnessRuns(
  q: PageQuery,
  run: {
    orgId: typeof runs.orgId | typeof sessions.orgId;
    workspaceId: typeof runs.workspaceId | typeof sessions.workspaceId;
    publicId: typeof runs.publicId | typeof sessions.publicId;
  },
): SQL | undefined {
  if (!q.withoutWitnessRuns) return undefined;
  return notWitnessRun(run);
}

// `operatorUserJoin` (the principal-to-user cross-domain join, agent/Tacho
// schema through IAM into auth) lives in @oxagen/database's relations seam,
// not here, and both selects below import it rather than redefine it.
//
// The name comes from `auth.users.display_name`, which Better Auth fills from
// the name the person gave at sign-up. It is deliberately not
// `iam.principals.display_name`: provisioning falls that column back to the
// user's email address, and a run row is a record, not a directory, so it
// carries a name or nothing.

const ledgerColumns = {
  run: {
    runId: runs.id,
    publicId: runs.publicId,
    status: runs.status,
    ingressRevoked: runs.cancelRequested,
    ingressPaused: runs.ingressPaused,
    createdAt: runs.createdAt,
    startedAt: runs.startedAt,
    name: runs.name,
    summary: runs.summary,
    summaryGeneratedAt: runs.summaryGeneratedAt,
    summaryModel: runs.summaryModel,
    summaryError: runs.summaryError,
  },
  identity: {
    orgNamespace: schema.organizations.namespace,
    workspaceNamespace: schema.workspaces.namespace,
    agentSlug: schema.agents.slug,
    operatorPublicId: schema.principals.publicId,
    operatorKind: schema.principals.kind,
    operatorUserName: schema.users.displayName,
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
    )
    .leftJoin(schema.users, operatorUserJoin);
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
        hideWitnessRuns(q, runs),
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

/**
 * A model call and a tool call have two spellings each: the ledger's own
 * `model.call_completed` / `tool.call_completed` and the in-app assistant's
 * `model.engine_call_completed` / `tool.engine_call_completed`. The registry
 * is the one place that knows both, so the counts below match on a set
 * rather than an equality. They matched only the first spelling before, and
 * the assistant is the only producer in the tree: every run it recorded
 * listed zero model calls, zero tool calls and zero turns on the Runs page
 * while its frame count climbed.
 */
const MODEL_CALL_TYPES = [...MODEL_CALL_EVENT_TYPES];
const TOOL_CALL_TYPES = [...TOOL_CALL_EVENT_TYPES];
const IS_MODEL_CALL = inArray(events.eventType, MODEL_CALL_TYPES);
const IS_TOOL_CALL = inArray(events.eventType, TOOL_CALL_TYPES);

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
        sql<number>`(count(*) filter (where ${IS_MODEL_CALL}))::int`.mapWith(
          Number,
        ),
      toolCalls:
        sql<number>`(count(*) filter (where ${IS_TOOL_CALL}))::int`.mapWith(
          Number,
        ),
      turnIndexes:
        sql<number>`(count(distinct ${events.payloadInline}->>'turn_index') filter (where ${IS_MODEL_CALL}))::int`.mapWith(
          Number,
        ),
      opaqueModelCalls:
        sql<number>`(count(*) filter (where ${IS_MODEL_CALL} and ${events.payloadInline} is null))::int`.mapWith(
          Number,
        ),
    })
    .from(events)
    .where(
      and(
        // A literal, not a bind parameter: the partial index on
        // `(run_id, run_seq) WHERE event_record_version = 2` is only usable
        // when the planner can see the predicate matches it.
        sql`${events.eventRecordVersion} = 2`,
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
        // `event_record_version = 2` changes no answer (only a V2 row has an
        // attempt id) but lets the partial `(attempt_id, attempt_seq)` index
        // answer the probe instead of a scan of the event log.
        sql`not exists (select 1 from ${events} where ${events.attemptId} = ${seals.attemptId} and ${events.eventRecordVersion} = 2)`,
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

/** The columns the Chain-and-seal tab reads off a seal row (ADR-058). */
const chainSealColumns = {
  runId: seals.runId,
  attemptId: seals.attemptId,
  sealedAt: seals.sealedAt,
  replayGrade: seals.replayGrade,
  completenessGaps: seals.completenessGaps,
  finalRunSeq: sql<string | null>`${seals.finalRunSeq}::text`,
  eventCount: seals.eventCount,
  merkleRoot: seals.merkleRoot,
  archiveSegmentRef: seals.archiveSegmentRef,
  enforcementTier: seals.enforcementTier,
  // The Chain-and-seal tab reads these; nothing else does, and reading
  // the run's own status in their place would answer the run's word for
  // the attempt's.
  terminalStatus: seals.terminalStatus,
  finalEventDigest: seals.finalEventDigest,
  eventStreamDigest: seals.eventStreamDigest,
};

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
    .selectDistinctOn([seals.runId], chainSealColumns)
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

/**
 * Every attempt seal of one run, oldest first: what `readAllFrames` already
 * walks (every attempt's frames), matched on the seal side, so the
 * Chain-and-seal tab shows one root per attempt instead of the latest
 * attempt's root beside a frame count that spans every attempt (finding 8,
 * macanderson/oxagen#3370).
 */
export function ledgerAllSealsQuery(
  db: QueryDb,
  scope: RunScope,
  runId: string,
) {
  return db
    .select(chainSealColumns)
    .from(seals)
    .where(
      and(
        eq(seals.orgId, scope.orgId),
        eq(seals.workspaceId, scope.workspaceId),
        eq(seals.runId, runId),
      ),
    )
    .orderBy(asc(seals.sealedAt));
}

const tachoColumns = {
  session: {
    // Internal UUID: `tacho.checkpoints.session_id` (and the other child
    // tables) reference this, not `session_uuid`. `get_run_chain` needs it
    // to load the signed checkpoints.
    id: sessions.id,
    publicId: sessions.publicId,
    sessionUuid: sessions.sessionUuid,
    harness: sessions.harness,
    harnessVersion: sessions.harnessVersion,
    runtime: sessions.runtime,
    agentKey: sessions.agentKey,
    outcome: sessions.outcome,
    numTurns: sessions.numTurns,
    numModelCalls: sessions.numModelCalls,
    numToolCalls: sessions.numToolCalls,
    seqCount: sessions.seqCount,
    startedAt: sessions.startedAt,
    sealedAt: sessions.sealedAt,
    sealSource: sessions.sealSource,
    endedAt: sessions.endedAt,
    replayGrade: sessions.replayGrade,
    completenessGaps: sessions.completenessGaps,
    enforcementTier: sessions.enforcementTier,
    // The sealed commitment (`terminalPatch`, `agent_stop`): the collector
    // stops checkpointing once `session.sealed` is written, so the last
    // periodic checkpoint can cover only a prefix. This is the hash rule's
    // answer for the whole session (`run.chain.get.ts`).
    finalHash: sessions.finalHash,
    name: sessions.name,
    // The deterministic fallback the ingest derives from the run's first
    // frames. `name` is written only by `summarize_run`, which refuses a
    // live run and refuses `digest_only` outright, so without this a run
    // showed its public id until it sealed and every `digest_only` run
    // showed one for ever. That is the whole point of deriving a title, and
    // it was being written to a column nothing read.
    title: sessions.title,
    // The title the harness gave the session itself (`harness-title.ts`).
    harnessTitle: sessions.harnessTitle,
    summary: sessions.summary,
    summaryGeneratedAt: sessions.summaryGeneratedAt,
    summaryModel: sessions.summaryModel,
    summaryError: sessions.summaryError,
    // `to_jsonb` takes a row, addressed by the FROM-clause's own
    // correlation name for this table, which is just its bare name and
    // never schema-qualified even though every column reference above is.
    // Interpolating `${sessions}` renders `"tacho"."sessions"`, which
    // Postgres reads as two identifiers and rejects with "missing
    // FROM-clause entry for table \"tacho\"" (the join list has no such
    // alias). `sql.identifier` prints the one name postgres accepts here.
    // JSON lookup remains safe before the additive column migration.
    // This depends on `tachoSessionsSelect` reading `.from(sessions)` with
    // no alias: under `alias()` or inside a subquery the bare table name is
    // no longer a FROM-clause entry and Postgres rejects the reference.
    machineSnapshot: sql<unknown>`to_jsonb(${sql.identifier(getTableName(sessions))})->'machine_snapshot'`,
    modelInitial: sessions.modelInitial,
    modelFinal: sessions.modelFinal,
    totalCostMicros: sessions.totalCostMicros,
    costBasis: sessions.costBasis,
    effort: sessions.effort,
    permissionModeInitial: sessions.permissionModeInitial,
    permissionModeFinal: sessions.permissionModeFinal,
    inputTokens: sessions.inputTokens,
    outputTokens: sessions.outputTokens,
    cacheReadTokens: sessions.cacheReadTokens,
    cacheCreationTokens: sessions.cacheCreationTokens,
    // What the page lists beside the run: how many `pr_open` calls ingest
    // counted, and the harness's own line totals from the session's end.
    pullRequests: sessions.pullRequests,
    linesAdded: sessions.linesAdded,
    linesRemoved: sessions.linesRemoved,
  },
  operatorPublicId: schema.principals.publicId,
  operatorKind: schema.principals.kind,
  operatorUserName: schema.users.displayName,
  host: {
    hostname: hosts.hostname,
    platform: hosts.platform,
    osVersion: hosts.osVersion,
    arch: hosts.arch,
    nodeVersion: hosts.nodeVersion,
    // Whether a command can reach the run (`commandBlockOf`, ADR-163).
    status: hosts.status,
    lastSeenAt: hosts.lastSeenAt,
  },
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
    )
    .leftJoin(schema.users, operatorUserJoin)
    .leftJoin(
      hosts,
      and(eq(hosts.id, sessions.hostId), eq(hosts.orgId, sessions.orgId)),
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
        hideWitnessRuns(q, sessions),
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

/**
 * The subagent chains under a root session, by `session_uuid`. Ingest writes
 * a `tacho.sessions` row for every chain before it writes the chain's frames
 * to ClickHouse, so this list names every chain a frame read can find, and
 * `tacho_sessions_root_idx` answers it.
 */
export function tachoChildSessionsQuery(
  db: QueryDb,
  scope: RunScope,
  rootSessionUuid: string,
) {
  return db
    .select({ sessionUuid: sessions.sessionUuid })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        eq(sessions.rootSessionUuid, rootSessionUuid),
        ne(sessions.sessionUuid, rootSessionUuid),
      ),
    );
}

// ---- Records and mapping -------------------------------------------------------------

/** The generated summary columns a run row carries (`summarize_run`, G14). */
type GeneratedSummaryColumns = {
  name: string | null;
  /**
   * The deterministic fallback a wrapped session's ingest derives. A ledger
   * run has no such column, so it is optional here rather than shared.
   */
  title?: string | null;
  /** The title the harness gave the session itself; wrapped sessions only. */
  harnessTitle?: string | null;
  summary: string | null;
  summaryGeneratedAt: Date | null;
  summaryModel: string | null;
  /** Why the last automatic account failed, as a short reason code. */
  summaryError?: string | null;
};

type LedgerRunCore = GeneratedSummaryColumns & {
  runId: string;
  publicId: string;
  /** `agent_runs.status` (CHECK: pending, running, completed, failed, cancelled). */
  status: string;
  ingressRevoked?: boolean;
  ingressPaused?: boolean;
  createdAt: Date;
  startedAt: Date | null;
};

export type LedgerRunIdentity = {
  orgNamespace: string | null;
  workspaceNamespace: string | null;
  agentSlug: string | null;
  /** `iam.principals.public_id` for `agent_runs.initiating_principal_id`. */
  operatorPublicId: string | null;
  /** `iam.principals.kind`; null when no principal was recorded. */
  operatorKind: string | null;
  /** `auth.users.display_name` for a human principal; null for any other. */
  operatorUserName: string | null;
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
  /** Null on a seal written before the column existed; read as `harness`. */
  enforcementTier: string | null;
  /** How the sealed attempt ended, as the seal recorded it. */
  terminalStatus: string;
  /** The digest of the attempt's last frame; null when it recorded none. */
  finalEventDigest: string | null;
  /** The fold of every frame digest in sequence; always written. */
  eventStreamDigest: string;
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

/**
 * What a `cost.run_totals` row says about a run: its spend, its witness
 * verdict, and whether the run had sealed when the row was rebuilt (null: it
 * had not, so the spend is a running estimate).
 */
type RunRollup = {
  cost: RunCost | null;
  verdict: RunItem["verdict"];
  sealedAt: Date | null;
};

export type TachoSessionColumns = GeneratedSummaryColumns & {
  harness?: string;
  harnessVersion?: string | null;
  runtime?: string;
  machineSnapshot?: unknown;
  /** `tacho.sessions.id`; foreign key for checkpoints and rollups. */
  id: string;
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
  /** `agent_stop`, `idle_timeout` or `operator`; null while open or on a seal older than the column. */
  sealSource?: string | null;
  /** The `agent_stop` event's own timestamp, or after an idle close or an operator's seal the last event's; null while open. */
  endedAt?: Date | null;
  /** The model the session started on and the one it ended on; either may be unrecorded. */
  modelInitial: string | null;
  modelFinal: string | null;
  totalCostMicros?: number;
  costBasis?: string | null;
  /** The effort level the harness reported in its context frames. */
  effort?: string | null;
  permissionModeInitial?: string | null;
  permissionModeFinal?: string | null;
  /** Token counters ingest folds from the session's counted `llm_call` frames. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** `pr_open` calls ingest counted; absent where a reader did not select it. */
  pullRequests?: number;
  /** The harness's line totals, written at the session's end; absent where not selected. */
  linesAdded?: number;
  linesRemoved?: number;
  /** Written by the seal at `agent_stop`; null while the session is open. */
  replayGrade: string | null;
  completenessGaps: unknown;
  enforcementTier: string;
  /** The sealed commitment for the whole session; null while open. */
  finalHash: string | null;
};

/**
 * The host columns the session's join carries. Every one is null when the
 * session names no host, or names one the workspace cannot read.
 */
export type TachoHostColumns = {
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  arch: string | null;
  nodeVersion: string | null;
  /** `tacho.hosts.status`; absent where a reader did not select it. */
  status?: string | null;
  /** The host's last poll; absent where a reader did not select it. */
  lastSeenAt?: Date | null;
};

export type TachoSessionRow = {
  session: TachoSessionColumns;
  /** `iam.principals.public_id` for `initiating_principal_id`. */
  operatorPublicId: string | null;
  /** `iam.principals.kind`; null when no principal was recorded. */
  operatorKind: string | null;
  /** `auth.users.display_name` for a human principal; null for any other. */
  operatorUserName: string | null;
  /** The enrolled host the session ran on, as its left join read it. */
  host: TachoHostColumns | null;
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

const LEDGER_RUN_OUTCOME: Readonly<Record<string, RunItem["outcome"]>> = {
  pending: "running",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * The word the ledger row holds, carried through. `status` folds `completed`
 * and `failed` into one word because both are sealed, so a reader who needs
 * to know which of the two happened reads this instead. A word outside the
 * column's CHECK is a broken row, and the read fails rather than guesses.
 */
export function ledgerRunOutcome(status: string): RunItem["outcome"] {
  const mapped = Object.hasOwn(LEDGER_RUN_OUTCOME, status)
    ? LEDGER_RUN_OUTCOME[status]
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

/**
 * The gaps a row publishes: the recorded list narrowed to the closed
 * vocabulary. A word the store holds that the vocabulary does not name is
 * dropped rather than passed on, because a caller decides from a closed set
 * and cannot act on a gap kind it has never heard of.
 */
export function publishedGaps(value: unknown): CompletenessGapKind[] {
  return recordedGaps(value).filter(isCompletenessGapKind);
}

/**
 * Where a recording's actions were observed from. A wrapped session records
 * its own tier; a ledger run's seal records the tier it was graded under, and
 * a seal written before that column existed — or a run that has not sealed —
 * reads as `harness`, which is what a submitted recording is (ADR-043).
 */
export function publishedTier(value: unknown): RunItem["enforcementTier"] {
  return isGradeEnforcementTier(value) ? value : "harness";
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

/** The failure reason, carried only while the run has no account to show. */
function enrichmentError(
  columns: GeneratedSummaryColumns,
): Pick<RunItem, "enrichmentError"> {
  return columns.summaryError && generatedSummary(columns) === null
    ? { enrichmentError: columns.summaryError }
    : {};
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
 * The run's cost as its rollup row records it. No row yet — the rollup has
 * not priced any of its frames — means no cost, never zero.
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

/**
 * Whether the run's cost is still an estimate: the run is open, or its row
 * was rebuilt before the seal and the seal's rollup has not landed yet.
 */
export function costIsEstimate(
  runSealedAt: Date | string | null,
  rollup: RunRollup | undefined,
): boolean {
  if (!rollup?.cost) return false;
  return runSealedAt === null || rollup.sealedAt === null;
}

/**
 * What sealed a sealed session. A seal written before `seal_source` existed
 * was an `agent_stop`, which is the only thing that sealed a session then.
 * `operator` is a person's `seal_run` (#4073).
 */
export function recordedSealSource(
  sealedAt: Date | null,
  source: string | null | undefined,
): RunItem["sealSource"] {
  if (sealedAt === null) return null;
  if (source === "idle_timeout") return "idle_timeout";
  if (source === "operator") return "operator";
  if (source === null || source === undefined || source === "agent_stop")
    return "agent_stop";
  throw new RangeError(
    `tacho session seal source outside the CHECK: ${source}`,
  );
}

/** A column an enrolment left empty reads as unrecorded, never as a value. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;

/**
 * The principal's kind as the column's CHECK spells it, or null. A word
 * outside the CHECK is a broken row, and it reads as "not recorded" rather
 * than as a kind this reader would draw conclusions from.
 */
export function principalKind(kind: string | null): RunItem["operatorKind"] {
  return PRINCIPAL_KINDS.find((known) => known === kind) ?? null;
}

/**
 * The machine as its host row records it, or null. A session with no host, and
 * a host row whose join found nothing, both answer null; the two facts the
 * host table requires (`hostname` and `platform`) are what a row is judged
 * present by, and the optional ones stay null where the enrolment left them.
 */
export function toRunMachine(
  host: TachoHostColumns | null | undefined,
  snapshot?: unknown,
): RunItem["machine"] {
  const hostname = host?.hostname?.trim() ?? "";
  const platform = host?.platform?.trim() ?? "";
  if (hostname.length === 0 || platform.length === 0) return null;
  const recorded = runMachineSnapshotSchema.safeParse(snapshot);
  return {
    hostname,
    ...(recorded.success ? { recorded: recorded.data } : {}),
    platform,
    osVersion: blankToNull(host?.osVersion),
    arch: blankToNull(host?.arch),
    nodeVersion: blankToNull(host?.nodeVersion),
  };
}

export function toLedgerRunItem(
  record: LedgerRunRecord,
  totals: RunRollup | undefined,
): RunItem {
  const { run, identity, rollup } = record;
  const status = ledgerRunStatus(run.status);
  const outcome = ledgerRunOutcome(run.status);
  // A live run has sealed nothing, so it has recorded no gaps — not "none".
  const gaps =
    status === "live" ? [] : publishedGaps(record.seal?.completenessGaps);
  return {
    id: run.publicId,
    source: "ledger",
    ingressRevoked: run.ingressRevoked ?? false,
    ingressPaused: run.ingressPaused ?? false,
    agentKey: composeAgentKey(
      identity.orgNamespace,
      identity.workspaceNamespace,
      identity.agentSlug,
    ),
    operatorId: identity.operatorPublicId,
    operatorKind: principalKind(identity.operatorKind),
    operatorName: blankToNull(identity.operatorUserName),
    operatorAttribution: identity.operatorPublicId ? "initiator" : null,
    status,
    outcome,
    turns: rollup.opaqueModelCalls === 0 ? rollup.turnIndexes : null,
    steps: rollup.modelCalls + rollup.toolCalls,
    frames: rollup.frames,
    cost: rollupCost(totals),
    costIsEstimate: costIsEstimate(
      status === "live" ? null : (record.seal?.sealedAt ?? null),
      totals,
    ),
    taskRef: identity.goal,
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    sealedAt:
      status === "live" ? null : (record.seal?.sealedAt.toISOString() ?? null),
    sealSource: null,
    // The ledger records no stop instant apart from its seal.
    endedAt:
      status === "live" ? null : (record.seal?.sealedAt.toISOString() ?? null),
    replayGrade:
      status === "live"
        ? null
        : recordedGrade(record.seal?.replayGrade ?? null),
    verdict: totals?.verdict ?? null,
    enforcementTier: publishedTier(record.seal?.enforcementTier),
    // A ledger run's controls fence evidence ingress; no host carries them.
    commandBlock: null,
    steerBlock: null,
    completenessGaps: gaps,
    canSummarize: canSummarizeRun({ status, completenessGaps: gaps }),
    // The ledger records evidence an external engine submits. It names no
    // model on the run row and no host at all, so both stay null rather than
    // being reconstructed from a frame that may not be there.
    model: null,
    effort: null,
    permissionMode: null,
    reportedTokens: null,
    machine: null,
    name: run.name,
    summary: generatedSummary(run),
    ...enrichmentError(run),
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
    case "completed":
    case "crashed":
    case "unknown":
      return "sealed";
    default:
      // A word outside the column's CHECK is a broken row. Reading it as
      // sealed would say the record is complete when nothing said so, which
      // is the one direction a status may never be wrong in. The ledger's
      // reader already fails here, and this one now fails the same way.
      throw new RangeError(
        `tacho session outcome outside the CHECK: ${outcome}`,
      );
  }
}

/**
 * The word the session row holds. `aborted` reads `cancelled`, the reading
 * `tachoRunStatus` already gives it, and `unknown` stays `unknown`: a session
 * whose harness stopped reporting before it recorded an end has not been
 * shown to have finished.
 */
export function tachoRunOutcome(outcome: string): RunItem["outcome"] {
  switch (outcome) {
    case "running":
      return "running";
    case "aborted":
      return "cancelled";
    case "completed":
      return "completed";
    case "crashed":
      return "crashed";
    case "unknown":
      return "unknown";
    default:
      throw new RangeError(
        `tacho session outcome outside the CHECK: ${outcome}`,
      );
  }
}

/**
 * The name a wrapped session shows, first match wins:
 *
 * 1. The title the harness gave the session (Claude Code's `ai-title`). The
 *    operator already sees it in their terminal, so a name Oxagen wrote does
 *    not replace it.
 * 2. `name`: the model-written name, or until one exists, the first sentence
 *    of the first prompt plus the branch that `run.enrich` writes.
 * 3. `title`: the place-and-counts title the ingest derives.
 *
 * A run always has something to be called.
 */
export function tachoRunName(session: {
  harnessTitle?: string | null;
  name: string | null;
  title?: string | null;
}): string | null {
  return session.harnessTitle ?? session.name ?? session.title ?? null;
}

/**
 * The run row's `commandBlock`: `dispatch_command`'s rule read over the same
 * session and host (ADR-163). Omitted when the reader selected no host
 * liveness, so a caller reads "not known" rather than a refusal nobody made.
 */
function tachoCommandBlock(
  row: TachoSessionRow,
  now: Date,
): Pick<RunItem, "commandBlock"> {
  const host = row.host?.hostname == null ? null : row.host;
  if (host !== null && host.status === undefined) return {};
  return {
    commandBlock: commandBlockOf({
      outcome: row.session.outcome,
      sealSource: row.session.sealSource,
      host:
        host === null || host.status == null
          ? null
          : { status: host.status, lastSeenAt: host.lastSeenAt ?? null },
      now,
    }),
  };
}

/**
 * The session's token counters, as ingest folded them from the counted
 * `llm_call` frames. Null for a session that recorded no model usage, so a
 * header says "not recorded" rather than "0 tokens".
 */
export function reportedTokensOf(
  session: Pick<
    TachoSessionColumns,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
  >,
): RunItem["reportedTokens"] {
  const count = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const input = count(session.inputTokens);
  const output = count(session.outputTokens);
  const cacheRead = count(session.cacheReadTokens);
  const cacheWrite = count(session.cacheCreationTokens);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    input + output + cacheRead + cacheWrite === 0
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

export function toTachoRunItem(
  row: TachoSessionRow,
  totals: RunRollup | undefined,
  now: Date = new Date(),
): RunItem {
  const { session } = row;
  const status = tachoRunStatus(session.outcome);
  const outcome = tachoRunOutcome(session.outcome);
  const gaps = status === "live" ? [] : publishedGaps(session.completenessGaps);
  return {
    id: session.publicId,
    source: "tacho",
    agentKey: session.agentKey,
    operatorId: row.operatorPublicId,
    operatorKind: principalKind(row.operatorKind),
    operatorName: blankToNull(row.operatorUserName),
    // Ingest attributes a wrapped session to the host's enroller
    // (`enrollingPrincipalId`), not to whoever ran it.
    operatorAttribution: row.operatorPublicId ? "host_enroller" : null,
    status,
    outcome,
    turns: session.numTurns,
    steps: session.numModelCalls + session.numToolCalls,
    frames: session.seqCount,
    cost: rollupCost(totals),
    costIsEstimate: costIsEstimate(session.sealedAt, totals),
    reportedCost:
      Number.isSafeInteger(session.totalCostMicros) &&
      ((session.totalCostMicros ?? 0) > 0 || session.costBasis != null)
        ? {
            micros: microsString(session.totalCostMicros ?? 0),
            currency: "USD",
            basis: "client_attested",
          }
        : null,
    // No dispatch record names a wrapped session's task (see the contract).
    taskRef: null,
    startedAt: session.startedAt.toISOString(),
    sealedAt: session.sealedAt?.toISOString() ?? null,
    sealSource: recordedSealSource(session.sealedAt, session.sealSource),
    // The stop event's own timestamp (`terminalPatch`), never receipt time.
    endedAt:
      status === "live" ? null : (session.endedAt?.toISOString() ?? null),
    replayGrade: recordedGrade(session.replayGrade),
    verdict: totals?.verdict ?? null,
    enforcementTier: publishedTier(session.enforcementTier),
    ...tachoCommandBlock(row, now),
    // Whether a steer can reach it (`steerBlockOf`); omitted when the reader
    // selected no runtime.
    ...(session.runtime === undefined
      ? {}
      : { steerBlock: steerBlockOf(session.runtime) }),
    completenessGaps: gaps,
    canSummarize: canSummarizeRun({ status, completenessGaps: gaps }),
    // The model the session ended on is the one that did most of its work, so
    // it is the one a row reports; a session that never recorded a switch has
    // only the one it started on.
    model: modelFactsOf(session.modelFinal ?? session.modelInitial),
    effort: blankToNull(session.effort ?? null),
    permissionMode: blankToNull(
      session.permissionModeFinal ?? session.permissionModeInitial ?? null,
    ),
    reportedTokens: reportedTokensOf(session),
    machine: toRunMachine(row.host, row.session.machineSnapshot),
    harness: session.harness
      ? {
          name: session.harness,
          version: blankToNull(session.harnessVersion ?? null),
          runtime: session.runtime ?? null,
        }
      : null,
    name: tachoRunName(session),
    summary: generatedSummary(session),
    ...enrichmentError(session),
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
        sealedAt: schema.runTotals.sealedAt,
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
    out.set(r.runId, {
      cost,
      verdict: recordedVerdict(r.verdict),
      sealedAt: r.sealedAt,
    });
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

/** The subagent chains under a root session in the scope's workspace. */
export async function postgresTachoChildSessions(
  scope: RunScope,
  rootSessionUuid: string,
): Promise<string[]> {
  const rows = await withTenantDb((tx) =>
    tachoChildSessionsQuery(tx, scope, rootSessionUuid),
  );
  return rows.map((r) => r.sessionUuid);
}

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
  readEnrichmentEnabled?: typeof readRunEnrichmentEnabled;
  /** The pull requests each wrapped session's frames name; absent reads none. */
  readPullRequests?: ReadRunPullRequests;
  /** Git's uncommitted change per wrapped session; absent reads none. */
  readGitDiffs?: ReadRunGitDiffs;
};

type FleetItem =
  | { kind: "ledger"; id: string; startedAt: string; row: LedgerRunRow }
  | { kind: "tacho"; id: string; startedAt: string; row: TachoSessionRow };

type LineCounts = { added: number; removed: number };

/**
 * How many sessions one batch of a filtered page reads, and how many batches
 * it reads before it returns what it found with a cursor past the last run it
 * looked at. A filter that matches rarely then costs at most five reads a
 * page, and the next page carries on from where this one stopped.
 */
export const FILTER_SCAN_BATCH = 100;
export const FILTER_SCAN_BATCHES = 5;

export function createRunListHandler(
  deps: RunListDeps,
): CapabilityHandler<typeof runList> {
  return async (input, ctx): Promise<RunListOutput> => {
    const scope = runScope(ctx);
    const cursor =
      input.cursor === undefined ? null : decodeRunCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw invalidCursor(runList.name);
    const filter = input.pullRequests ?? "any";
    const withoutWitnessRuns = hidesWitnessRuns(ctx);

    // The enrichment flag depends on nothing the pages return, so it is read
    // alongside them rather than after the rollups.
    const enabledRead = deps.readEnrichmentEnabled
      ? deps.readEnrichmentEnabled(scope)
      : Promise.resolve(true);

    // One merged newest-first page. A filtered page reads wrapped sessions
    // only: a ledger run's pull requests are receipts this read cannot see,
    // so it can be listed as neither "with" nor "without".
    async function readBatch(at: RunCursor | null, limit: number) {
      const page = { cursor: at, limit, withoutWitnessRuns };
      const [ledger, tacho] = await Promise.all([
        filter === "any"
          ? deps.queries.ledgerPage(scope, page)
          : Promise.resolve([]),
        deps.queries.tachoPage(scope, page),
      ]);
      return mergeNewestFirst<FleetItem>(
        [
          {
            items: ledger.slice(0, limit).map((row) => ({
              kind: "ledger" as const,
              id: row.run.publicId,
              startedAt: (row.run.startedAt ?? row.run.createdAt).toISOString(),
              row,
            })),
            overflowed: ledger.length > limit,
          },
          {
            items: tacho.slice(0, limit).map((row) => ({
              kind: "tacho" as const,
              id: row.session.publicId,
              startedAt: row.session.startedAt.toISOString(),
              row,
            })),
            overflowed: tacho.length > limit,
          },
        ],
        limit,
      );
    }

    // The pull requests the frames name, per session uuid. A session missing
    // from the map was not read, and its row carries no `pullRequests`.
    const links = new Map<string, RunPullRequest[]>();
    let linksUnread = false;
    async function readLinks(items: readonly FleetItem[]) {
      const read = deps.readPullRequests;
      if (read === undefined) return;
      const uuids = items.flatMap((item) =>
        item.kind === "tacho" && !links.has(item.row.session.sessionUuid)
          ? [item.row.session.sessionUuid]
          : [],
      );
      if (uuids.length === 0) return;
      try {
        const found = await read(uuids);
        for (const uuid of uuids) links.set(uuid, found.get(uuid) ?? []);
      } catch (err) {
        linksUnread = true;
        logger.warn(
          { err, sessions: uuids.length },
          "list_runs: the pull-request frames could not be read; rows carry none",
        );
      }
    }

    let items: FleetItem[];
    let nextCursor: string | null;
    if (filter === "any") {
      const page = await readBatch(cursor, input.limit);
      items = page.items;
      nextCursor = page.nextCursor;
      await readLinks(items);
    } else {
      items = [];
      nextCursor = null;
      let at = cursor;
      for (let batch = 1; ; batch += 1) {
        const page = await readBatch(at, FILTER_SCAN_BATCH);
        await readLinks(page.items);
        let full: FleetItem | null = null;
        for (const item of page.items) {
          if (item.kind !== "tacho") continue;
          const session = item.row.session;
          if (
            !matchesPullRequestFilter(
              filter,
              links.get(session.sessionUuid),
              session.pullRequests,
            )
          )
            continue;
          items.push(item);
          if (items.length === input.limit) {
            full = item;
            break;
          }
        }
        if (full !== null) {
          // The page is full. Older runs remain when this batch had runs
          // after the last one taken, or more batches follow it.
          const more = full !== page.items.at(-1) || page.nextCursor !== null;
          nextCursor = more
            ? encodeRunCursor({ at: full.startedAt, id: full.id })
            : null;
          break;
        }
        if (page.nextCursor === null) break;
        if (batch >= FILTER_SCAN_BATCHES) {
          nextCursor = page.nextCursor;
          break;
        }
        at = decodeRunCursor(page.nextCursor);
      }
    }

    // Git's figure is read only for the sessions with no harness totals,
    // which are the only rows that would show it.
    const needGit = items.flatMap((item) =>
      item.kind === "tacho" &&
      (item.row.session.linesAdded ?? 0) === 0 &&
      (item.row.session.linesRemoved ?? 0) === 0
        ? [item.row.session.sessionUuid]
        : [],
    );
    const noGit = new Map<string, LineCounts>();
    const [enabled, enrich, costs, gitDiffs] = await Promise.all([
      enabledRead,
      ledgerEnrichment(
        deps,
        scope,
        items.flatMap((item) =>
          item.kind === "ledger" ? [item.row.run.runId] : [],
        ),
      ),
      deps.readRunRollups(
        scope,
        items.map((item) => item.id),
      ),
      deps.readGitDiffs === undefined || needGit.length === 0
        ? Promise.resolve(noGit)
        : deps.readGitDiffs(scope, needGit).catch((err: unknown) => {
            logger.warn(
              { err, sessions: needGit.length },
              "list_runs: git's change could not be read; rows show the harness totals alone",
            );
            return noGit;
          }),
    ]);
    return {
      runs: items.map((item) => {
        const run =
          item.kind === "ledger"
            ? toLedgerRunItem(enrich(item.row), costs.get(item.id))
            : {
                ...toTachoRunItem(item.row, costs.get(item.id)),
                ...tachoWorkFields(item.row.session, links, gitDiffs),
              };
        return {
          ...run,
          enrichmentEnabled: enabled,
          ...(enabled
            ? {}
            : {
                // Turning automatic accounts off hides what Oxagen wrote,
                // not the title the harness gave the session.
                name:
                  item.kind === "tacho"
                    ? (item.row.session.harnessTitle ?? null)
                    : null,
                summary: null,
                canSummarize: false,
                enrichmentError: undefined,
              }),
        };
      }),
      nextCursor,
      ...(linksUnread ? { warnings: ["pull_requests_unread" as const] } : {}),
    };
  };
}

/** The pull requests, the `pr_open` count and the lines a wrapped session's row carries. */
function tachoWorkFields(
  session: TachoSessionColumns,
  links: ReadonlyMap<string, RunPullRequest[]>,
  gitDiffs: ReadonlyMap<string, LineCounts>,
): Pick<RunItem, "pullRequests" | "pullRequestsOpened" | "diff"> {
  const pulls = links.get(session.sessionUuid);
  return {
    ...(pulls === undefined ? {} : { pullRequests: pulls }),
    ...(session.pullRequests === undefined
      ? {}
      : { pullRequestsOpened: session.pullRequests }),
    diff: runDiffOf(session, gitDiffs.get(session.sessionUuid)),
  };
}

export const runListHandler = createRunListHandler({
  queries: postgresRunQueries,
  readRunRollups: postgresReadRunRollups,
  readEnrichmentEnabled: readRunEnrichmentEnabled,
  readPullRequests: readRunPullRequests,
  readGitDiffs: postgresRunGitDiffs,
});
