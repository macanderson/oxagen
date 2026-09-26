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
  HOST_POLL_WINDOW_MS,
  IN_APP_AGENT_SURFACES,
  type RunItem,
  runList,
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
  MODEL_CALL_EVENT_TYPES,
  TOOL_CALL_EVENT_TYPES,
} from "@oxagen/run-ledger";
import { modelCallHidesTurn } from "@oxagen/billing";
import {
  EMPTY_ROLLUP,
  LEDGER_LIVE_STATUSES,
  TACHO_LIVE_OUTCOMES,
  type LedgerEventRollup,
  type LedgerRunRecord,
  type LedgerRunRow,
  type LedgerSeal,
  type RunCost,
  type RunRollup,
  type TachoSessionColumns,
  type TachoSessionRow,
  toLedgerRunItem,
  toTachoRunItem,
} from "./lib/run-item";
import {
  matchesPullRequestFilter,
  postgresRunGitDiffs,
  type ReadRunGitDiffs,
  type ReadRunPullRequests,
  readRunPullRequests,
  runDiffOf,
} from "./lib/run-list-work";
import { isCursorInstant } from "./lib/cursor-instant";
import { compactedProbe } from "./lib/run-list-status";
import { appliedHaltIsPause } from "./lib/run-pause";
import { logger } from "./logger";
import {
  countRuns,
  isNewestFirst,
  postgresRunIndex,
  readRunIndexPage,
  refuseRunIndexInput,
  type RunIndexDeps,
  type RunRowsByPublicId,
  runIndexRequest,
  usesRunIndex,
} from "./run.list.index";
import { PROOF_VERDICTS } from "@oxagen/run-evidence";
import {
  and,
  asc,
  desc,
  eq,
  getTableName,
  gte,
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
      !isCursorInstant(value[0]) ||
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
  q: Pick<PageQuery, "withoutWitnessRuns">,
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
/**
 * The ledger runs `list_runs` lists in a workspace, whatever the cursor: V2
 * runs, not the in-app agent's own turns, and no witness run when the caller
 * holds an API key. The page and the live count both read it, so the count
 * counts exactly the runs the pages list.
 */
function ledgerListed(
  scope: RunScope,
  q: Pick<PageQuery, "withoutWitnessRuns">,
): (SQL | undefined)[] {
  return [
    eq(runs.orgId, scope.orgId),
    eq(runs.workspaceId, scope.workspaceId),
    eq(runs.specVersion, 2),
    notInArray(runs.surface, [...IN_APP_AGENT_SURFACES]),
    hideWitnessRuns(q, runs),
  ];
}

export function ledgerPageQuery(db: QueryDb, scope: RunScope, q: PageQuery) {
  return ledgerRunsSelect(db)
    .where(
      and(
        ...ledgerListed(scope, q),
        beforeCursor(ledgerStartedAt, runs.publicId, q.cursor),
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
        // The cost rollup's rule, which is the seal's. Testing the payload for
        // null alone counted an engine call as legible, so the Runs page listed
        // `turns: 0` until compaction swapped in the seal's `null` (#3372).
        sql<number>`(count(*) filter (where ${IS_MODEL_CALL} and ${modelCallHidesTurn(events.payloadInline)}))::int`.mapWith(
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
        compactedProbe(),
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
  // Whether compaction moved this attempt's frames to its archive (ADR-193).
  compacted: compactedProbe(),
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
    // The server's clock, which the tacho_events TTL counts from.
    // `get_run_chain` reads it to tell expired frames from missing ones.
    createdAt: sessions.createdAt,
    sealedAt: sessions.sealedAt,
    sealSource: sessions.sealSource,
    endedAt: sessions.endedAt,
    replayGrade: sessions.replayGrade,
    completenessGaps: sessions.completenessGaps,
    // False from the first chain break on. `get_run_work` reports it beside
    // the facts it reads, since it reads them from every frame (ADR-171).
    chainVerified: sessions.chainVerified,
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
    // Where the session ran, as its start recorded it (the Run header's
    // checkout strip, while the work read is pending or when it failed). The
    // path is read in `get_run_work`'s order: the worktree, then the project
    // directory, then the working directory.
    cwd: sessions.cwd,
    projectDir: sessions.projectDir,
    worktreePath: sessions.worktreePath,
    gitBranch: sessions.gitBranch,
    worktreeBranch: sessions.worktreeBranch,
    // The digest of the session's git remote, which `get_run` matches to a
    // connected repository to name it.
    gitRemoteDigest: sessions.gitRemoteDigest,
    permissionModeInitial: sessions.permissionModeInitial,
    permissionModeFinal: sessions.permissionModeFinal,
    inputTokens: sessions.inputTokens,
    outputTokens: sessions.outputTokens,
    cacheReadTokens: sessions.cacheReadTokens,
    cacheCreationTokens: sessions.cacheCreationTokens,
    // Whether the host holds the session paused (`appliedHaltIsPause`, the
    // rule `get_run` reads its pause by). The subquery names the outer table
    // the way `machineSnapshot` does, so it depends on the same unaliased
    // `.from(sessions)`.
    paused: appliedHaltIsPause({
      orgId: sessions.orgId,
      workspaceId: sessions.workspaceId,
      publicId: sessions.publicId,
    }),
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

/**
 * The wrapped sessions `list_runs` lists in a workspace, whatever the cursor:
 * root sessions only, and no witness run when the caller holds an API key.
 * The page and the live count both read it.
 */
function tachoListed(
  scope: RunScope,
  q: Pick<PageQuery, "withoutWitnessRuns">,
): (SQL | undefined)[] {
  return [
    eq(sessions.orgId, scope.orgId),
    eq(sessions.workspaceId, scope.workspaceId),
    isNull(sessions.parentSessionUuid),
    hideWitnessRuns(q, sessions),
  ];
}

/** Root wrapped-agent sessions in the workspace, newest first. */
export function tachoPageQuery(db: QueryDb, scope: RunScope, q: PageQuery) {
  return tachoSessionsSelect(db)
    .where(
      and(
        ...tachoListed(scope, q),
        beforeCursor(sql`${sessions.startedAt}`, sessions.publicId, q.cursor),
      ),
    )
    .orderBy(desc(ms(sessions.startedAt)), desc(byteOrder(sessions.publicId)))
    .limit(q.limit + 1);
}

/** V2 ledger runs by public id, in the scope's workspace (the run index's page). */
export function ledgerByPublicIdsQuery(
  db: QueryDb,
  scope: RunScope,
  publicIds: readonly string[],
) {
  return ledgerRunsSelect(db).where(
    and(
      inArray(runs.publicId, [...publicIds]),
      eq(runs.orgId, scope.orgId),
      eq(runs.workspaceId, scope.workspaceId),
      eq(runs.specVersion, 2),
    ),
  );
}

/** Root sessions by public id, in the scope's workspace (the run index's page). */
export function tachoByPublicIdsQuery(
  db: QueryDb,
  scope: RunScope,
  publicIds: readonly string[],
) {
  return tachoSessionsSelect(db).where(
    and(
      inArray(sessions.publicId, [...publicIds]),
      eq(sessions.orgId, scope.orgId),
      eq(sessions.workspaceId, scope.workspaceId),
      isNull(sessions.parentSessionUuid),
    ),
  );
}

/** The run index's rows, read through the keyset page's own selects. */
export const postgresRunRows: RunRowsByPublicId = {
  ledger: (scope, publicIds) =>
    withTenantDb((tx) => ledgerByPublicIdsQuery(tx, scope, publicIds)),
  tacho: (scope, publicIds) =>
    withTenantDb((tx) => tachoByPublicIdsQuery(tx, scope, publicIds)),
};
/**
 * How many of the runs `list_runs` lists in the workspace are live, whatever
 * the page, the cursor or the pull-request filter: one count per store, each
 * over the same predicates its page reads (`ledgerListed`, `tachoListed`).
 *
 * A wrapped session whose row reads stale is not counted: its host is revoked,
 * or has not polled within `HOST_POLL_WINDOW_MS` of `now`. That is the rule
 * `commandBlockOf` applies to the row (`host_revoked`, `host_offline`), so
 * the count and the rows' lights agree. A session with no host has no poll to
 * miss and is counted, as its row reads live.
 */
export function liveCountQueries(
  db: QueryDb,
  scope: RunScope,
  q: Pick<PageQuery, "withoutWitnessRuns">,
  now: Date,
) {
  const count = { count: sql<number>`count(*)::int` };
  const polledSince = new Date(now.getTime() - HOST_POLL_WINDOW_MS);
  return {
    ledger: db
      .select(count)
      .from(runs)
      .where(
        and(
          ...ledgerListed(scope, q),
          inArray(runs.status, [...LEDGER_LIVE_STATUSES]),
        ),
      ),
    tacho: db
      .select(count)
      .from(sessions)
      .leftJoin(
        hosts,
        and(eq(hosts.id, sessions.hostId), eq(hosts.orgId, sessions.orgId)),
      )
      .where(
        and(
          ...tachoListed(scope, q),
          inArray(sessions.outcome, [...TACHO_LIVE_OUTCOMES]),
          or(
            isNull(hosts.id),
            and(
              ne(hosts.status, "revoked"),
              gte(hosts.lastSeenAt, polledSince),
            ),
          ),
        ),
      ),
  };
}

/** The live runs in a workspace, from both stores, as of `now`. */
export type ReadLiveRunCount = (
  scope: RunScope,
  q: Pick<PageQuery, "withoutWitnessRuns">,
  now: Date,
) => Promise<number>;

export const postgresLiveRunCount: ReadLiveRunCount = (scope, q, now) =>
  withTenantDb(async (tx) => {
    const { ledger, tacho } = liveCountQueries(tx, scope, q, now);
    const [[a], [b]] = await Promise.all([ledger, tacho]);
    return Number(a?.count ?? 0) + Number(b?.count ?? 0);
  });

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

// The record types and row mappers live in ./lib/run-item. Re-exported so
// every importer of this module keeps its path.
export {
  composeAgentKey,
  costIsEstimate,
  EMPTY_ROLLUP,
  LEDGER_LIVE_STATUSES,
  ledgerRunOutcome,
  ledgerRunStatus,
  microsString,
  principalKind,
  publishedGaps,
  publishedTier,
  recordedGaps,
  recordedSealSource,
  reportedTokensOf,
  TACHO_LIVE_OUTCOMES,
  tachoPlace,
  tachoRunName,
  tachoRunOutcome,
  tachoRunStatus,
  toLedgerRunItem,
  toRunMachine,
  toTachoRunItem,
} from "./lib/run-item";
export type {
  LedgerEventRollup,
  LedgerRunIdentity,
  LedgerRunRecord,
  LedgerRunRow,
  LedgerSeal,
  RunCost,
  TachoHostColumns,
  TachoSessionColumns,
  TachoSessionRow,
} from "./lib/run-item";

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
        tokens: schema.runTotals.tokens,
        cacheHitRate: schema.runTotals.cacheHitRate,
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
      tokens: r.tokens,
      // `numeric` reaches here as a string.
      cacheHitRate: r.cacheHitRate === null ? null : Number(r.cacheHitRate),
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
  /**
   * The run index (#3837): the filters, the search, the order, the offset and
   * the bounded total. Absent, a page carries no total and an input that
   * needs the index is refused.
   */
  runIndex?: RunIndexDeps;
  /** The workspace's live runs, whatever the page; absent leaves `liveRuns` out. */
  readLiveCount?: ReadLiveRunCount;
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
    refuseRunIndexInput(runList.name, input);
    const filter = input.pullRequests ?? "any";
    const withoutWitnessRuns = hidesWitnessRuns(ctx);
    const runIndex = deps.runIndex;
    const indexed = usesRunIndex(input);
    if (indexed && runIndex === undefined)
      throw new Error("list_runs: the run index is not wired");

    // The total counts every run the filters and the search let through,
    // whatever the page. It depends on nothing a page returns, so it is read
    // beside the pages. Only a caller that asks pays for it: a count reads
    // every matching row up to the bound in both stores.
    const counted =
      runIndex === undefined || input.count !== true
        ? Promise.resolve<Pick<RunListOutput, "total" | "totalBound">>({})
        : countRuns(
            runIndex.index,
            scope,
            runIndexRequest(input, {
              cursor: null,
              limit: input.limit,
              withoutWitnessRuns,
            }),
          );

    // The enrichment flag depends on nothing the pages return, so it is read
    // alongside them rather than after the rollups.
    const enabledRead = deps.readEnrichmentEnabled
      ? deps.readEnrichmentEnabled(scope)
      : Promise.resolve(true);
    // So is the live count, which is the workspace's and not the page's
    // (Fleet's Live runs tile). It reads every root session the workspace
    // holds, so only a caller that asks for it pays for it. A failed count
    // leaves the field out rather than failing the page, and the tile says it
    // was not counted. The rows' lights read the same clock.
    const now = new Date();
    const liveRead: Promise<number | undefined> =
      deps.readLiveCount === undefined || input.countLive !== true
        ? Promise.resolve(undefined)
        : deps
            .readLiveCount(scope, { withoutWitnessRuns }, now)
            .catch((err: unknown) => {
              logger.warn(
                { err },
                "list_runs: the workspace's live runs could not be counted; the page carries no count",
              );
              return undefined;
            });

    // One merged newest-first page. A filtered page reads wrapped sessions
    // only: a ledger run's pull requests are receipts this read cannot see,
    // so it can be listed as neither "with" nor "without".
    async function readBatch(at: RunCursor | null, limit: number) {
      if (indexed && runIndex !== undefined) {
        const read = await readRunIndexPage(
          runIndex,
          scope,
          runIndexRequest(input, { cursor: at, limit, withoutWitnessRuns }),
        );
        const last = read.items.at(-1);
        return {
          items: read.items,
          // A cursor is a position in the newest-first order. In any other
          // order the caller pages by offset.
          nextCursor:
            read.more && last !== undefined && isNewestFirst(input.sort)
              ? encodeRunCursor({ at: last.startedAt, id: last.id })
              : null,
        };
      }
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
    const [enabled, enrich, costs, gitDiffs, total, liveRuns] =
      await Promise.all([
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
      counted,
      liveRead,
    ]);
    return {
      runs: items.map((item) => {
        const run =
          item.kind === "ledger"
            ? toLedgerRunItem(enrich(item.row), costs.get(item.id))
            : {
                ...toTachoRunItem(item.row, costs.get(item.id), now),
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
      ...(liveRuns === undefined ? {} : { liveRuns }),
      ...(linksUnread ? { warnings: ["pull_requests_unread" as const] } : {}),
      ...total,
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
  runIndex: { index: postgresRunIndex, rows: postgresRunRows },
  readLiveCount: postgresLiveRunCount,
});
