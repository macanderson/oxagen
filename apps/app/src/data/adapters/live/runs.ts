// The live runs adapter (Batch 3 lane A1): Fleet's runs list, the Run header
// and the Run page's frames, read from the stores that record runs today.
//
//   arun_…  the run evidence ledger (@oxagen/run-ledger RunStore):
//           getRunByPublicId, listRunAttempts, readAttemptEventsSince; the
//           Fleet page selects the same agent.agent_runs columns, folds counts
//           from agent.agent_run_events, and joins token spend from ClickHouse
//           token_usage (sumTokenUsageByExecutionStep).
//   tse_…   wrapped agents in tacho.sessions (root sessions only; a subagent
//           chain is part of its parent's run).
//
// Every read enters the viewer's tenant scope (runInTenantScope) and every
// Postgres read goes through withTenantDb, whose RLS is the tenant filter; the
// queries below ALSO name org_id and workspace_id, because a local stack runs
// with the RLS bypass on and a run from another workspace must still 404.
//
// A read whose store is down answers the page's named error (page-states.ts);
// a row the view model cannot express answers `not_backed` (mappers/runs.ts).
//
// INTERIM (listed under "promote" in the lane PR): tacho sessions are read with
// withTenantDb rather than through `list_tacho_sessions` / `get_tacho_session`.
// Those contracts' outputs carry no run public id, operator, seal time or cost
// basis, and a read port receives a Scope with no actor for the kernel's IAM
// check. Swapping `tachoPage`/`tachoSession` for kernel invokes is local to
// this file once both land.
import "server-only";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import {
  type AttemptEventReadRecord,
  createPostgresRunStore,
  type RunStore,
} from "@oxagen/run-ledger";
import {
  captureError,
  sumTokenUsageByExecutionStep,
  type TokenUsageByStepRow,
} from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Frame, type RunDetail, type RunPage } from "@/data/contracts/runs";
import { notBackedFor as notBackedForMethod } from "@/data/backing";
import { notBacked, type Read, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { RunReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import {
  decodeRunCursor,
  EMPTY_ROLLUP,
  type LedgerEventRollup,
  type LedgerRunCore,
  type LedgerRunIdentity,
  latestSealAt,
  mergeNewestFirst,
  RUN_RECORD_INVALID,
  type RunCursor,
  type TachoSessionRecord,
  toLedgerFrame,
  toLedgerRunDetail,
  toLedgerRunRow,
  toTachoRunDetail,
  toTachoRunRow,
} from "./mappers/runs";

/** Fleet rows per page. */
export const RUN_PAGE_SIZE = 50;
/** The most frames one `framesSince` call returns. */
export const MAX_FRAMES_PER_READ = 500;
/**
 * Event pages `framesSince` reads past when every event on them has no frame
 * kind, so a cursor never parks behind a run of unmapped events.
 */
export const MAX_SKIPPED_EVENT_PAGES = 20;
/** Touched paths listed on the Run header (the tacho contract's own cap). */
export const TOUCHED_PATHS_LIMIT = 1000;

const LEDGER_RUN_ID = /^arun_[0-9a-z]+$/;
const TACHO_RUN_ID = /^tse_[0-9a-z]+$/;
const DECIMAL_CURSOR = /^-?\d+$/;

export type RunIdKind = "ledger" | "tacho";

/** Which store a run public id lives in; null for an id neither store mints. */
export function runIdKind(runId: string): RunIdKind | null {
  if (LEDGER_RUN_ID.test(runId)) return "ledger";
  if (TACHO_RUN_ID.test(runId)) return "tacho";
  return null;
}

const runNotFound = () => readError("run_not_found", 404);
const workspaceRequired = () => readError("workspace_required", 400);
const invalidCursor = () => readError("invalid_cursor", 400);

// ---- Queries -------------------------------------------------------------------------

/** What a query needs from a transaction: the select builder. */
export type QueryDb = Pick<Tx, "select">;

const runs = schema.agentRuns;
const events = schema.agentRunEvents;
const seals = schema.agentRunAttemptSeals;
const sessions = schema.tachoSessions;
const sessionFiles = schema.tachoSessionFiles;

/** Millisecond precision, so a cursor built from a JS Date compares exactly. */
const ms = (column: SQL | SQL.Aliased | typeof sessions.startedAt) =>
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

type PageQuery = { live: boolean; cursor: RunCursor | null; limit: number };

const ledgerColumns = {
  run: {
    runId: runs.id,
    publicId: runs.publicId,
    specVersion: runs.specVersion,
    status: runs.status,
    createdAt: runs.createdAt,
    startedAt: runs.startedAt,
  },
  identity: {
    workspaceSlug: schema.workspaces.slug,
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

/** V2 ledger runs in the workspace, newest first (legacy V1 rows carry no run identity). */
export function ledgerPageQuery(db: QueryDb, scope: Scope, q: PageQuery) {
  return ledgerRunsSelect(db)
    .where(
      and(
        eq(runs.orgId, scope.orgId),
        eq(runs.workspaceId, scope.workspaceId),
        eq(runs.specVersion, 2),
        q.live ? inArray(runs.status, ["pending", "running"]) : undefined,
        beforeCursor(ledgerStartedAt, runs.publicId, q.cursor),
      ),
    )
    .orderBy(desc(ms(ledgerStartedAt)), desc(byteOrder(runs.publicId)))
    .limit(q.limit + 1);
}

/** One run's identity, only when it belongs to the scope's workspace. */
export function ledgerIdentityQuery(db: QueryDb, scope: Scope, runId: string) {
  return ledgerRunsSelect(db)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.orgId, scope.orgId),
        eq(runs.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);
}

const MODEL_CALL = "model.call_completed";
const TOOL_CALL = "tool.call_completed";

/** Frame, step and turn counts folded from the V2 event log, per run. */
export function ledgerRollupQuery(
  db: QueryDb,
  scope: Scope,
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
      lastModel: sql<
        string | null
      >`(array_agg(${events.payloadInline}->>'model' order by ${events.runSeq} desc) filter (where ${events.eventType} = ${MODEL_CALL} and ${events.payloadInline} is not null))[1]`,
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

/** The latest attempt seal per run, for the Fleet page. */
export function ledgerSealQuery(
  db: QueryDb,
  scope: Scope,
  runIds: readonly string[],
) {
  return db
    .select({
      runId: seals.runId,
      sealedAt: sql<Date>`max(${seals.sealedAt})`.mapWith(seals.sealedAt),
    })
    .from(seals)
    .where(
      and(
        eq(seals.orgId, scope.orgId),
        eq(seals.workspaceId, scope.workspaceId),
        inArray(seals.runId, [...runIds]),
      ),
    )
    .groupBy(seals.runId);
}

const tachoColumns = {
  sessionId: sessions.id,
  session: {
    publicId: sessions.publicId,
    agentKey: sessions.agentKey,
    outcome: sessions.outcome,
    numTurns: sessions.numTurns,
    numModelCalls: sessions.numModelCalls,
    numToolCalls: sessions.numToolCalls,
    seqCount: sessions.seqCount,
    totalCostMicros: sessions.totalCostMicros,
    hasUnknownModelCost: sessions.hasUnknownModelCost,
    inputTokens: sessions.inputTokens,
    outputTokens: sessions.outputTokens,
    cacheReadTokens: sessions.cacheReadTokens,
    cacheCreationTokens: sessions.cacheCreationTokens,
    modelInitial: sessions.modelInitial,
    modelFinal: sessions.modelFinal,
    startedAt: sessions.startedAt,
    sealedAt: sessions.sealedAt,
  },
  workspaceSlug: schema.workspaces.slug,
  operatorPublicId: schema.principals.publicId,
};

function tachoSessionsSelect(db: QueryDb) {
  return db
    .select(tachoColumns)
    .from(sessions)
    .innerJoin(
      schema.workspaces,
      and(
        eq(schema.workspaces.id, sessions.workspaceId),
        eq(schema.workspaces.orgId, sessions.orgId),
      ),
    )
    .leftJoin(
      schema.principals,
      and(
        eq(schema.principals.id, sessions.initiatingPrincipalId),
        eq(schema.principals.orgId, sessions.orgId),
      ),
    );
}

/** Root wrapped-agent sessions in the workspace, newest first. */
export function tachoPageQuery(db: QueryDb, scope: Scope, q: PageQuery) {
  return tachoSessionsSelect(db)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        isNull(sessions.parentSessionUuid),
        q.live ? eq(sessions.outcome, "running") : undefined,
        beforeCursor(sql`${sessions.startedAt}`, sessions.publicId, q.cursor),
      ),
    )
    .orderBy(desc(ms(sessions.startedAt)), desc(byteOrder(sessions.publicId)))
    .limit(q.limit + 1);
}

/** One root session by public id, only in the scope's workspace. */
export function tachoSessionQuery(db: QueryDb, scope: Scope, publicId: string) {
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

/** Paths a session wrote, edited or deleted, in the order it first touched them. */
export function tachoTouchedQuery(
  db: QueryDb,
  scope: Scope,
  sessionId: string,
) {
  return db
    .select({ path: sessionFiles.path })
    .from(sessionFiles)
    .where(
      and(
        eq(sessionFiles.sessionId, sessionId),
        eq(sessionFiles.orgId, scope.orgId),
        eq(sessionFiles.workspaceId, scope.workspaceId),
        or(
          gt(sessionFiles.writes, 0),
          gt(sessionFiles.edits, 0),
          gt(sessionFiles.deletes, 0),
        ),
      ),
    )
    .orderBy(asc(sessionFiles.firstSeq), asc(sessionFiles.path))
    .limit(TOUCHED_PATHS_LIMIT);
}

// ---- Dependencies -------------------------------------------------------------------

type LedgerPageRow = { run: LedgerRunCore; identity: LedgerRunIdentity };
type TachoRow = TachoSessionRecord & { sessionId: string };
type FleetItem =
  | { kind: "ledger"; id: string; startedAt: string; row: LedgerPageRow }
  | { kind: "tacho"; id: string; startedAt: string; row: TachoRow };

/** The reads the adapter makes. Each runs inside the caller's tenant scope. */
export type RunQueries = {
  ledgerPage: (scope: Scope, q: PageQuery) => Promise<LedgerPageRow[]>;
  ledgerIdentity: (
    scope: Scope,
    runId: string,
  ) => Promise<LedgerRunIdentity | null>;
  ledgerRollups: (
    scope: Scope,
    runIds: readonly string[],
  ) => Promise<Map<string, LedgerEventRollup>>;
  ledgerSeals: (
    scope: Scope,
    runIds: readonly string[],
  ) => Promise<Map<string, Date>>;
  tachoPage: (scope: Scope, q: PageQuery) => Promise<TachoRow[]>;
  tachoSession: (scope: Scope, publicId: string) => Promise<TachoRow | null>;
  tachoTouched: (scope: Scope, sessionId: string) => Promise<string[]>;
};

export type LiveRunsDeps = {
  /** Enter the viewer's tenant scope for the whole read. */
  inScope: <T>(scope: Scope, fn: () => Promise<T>) => Promise<T>;
  /** The ledger's read side (RunStore). */
  store: {
    getRunByPublicId: RunStore["getRunByPublicId"];
    listRunAttempts: RunStore["listRunAttempts"];
    readAttemptEventsSince: RunStore["readAttemptEventsSince"];
  };
  queries: RunQueries;
  sumTokenUsage: (args: {
    orgId: string;
    executionStepIds: readonly string[];
  }) => Promise<Map<string, TokenUsageByStepRow>>;
  /** Where a store failure is recorded before the read answers its error. */
  report: (error: unknown, context: string) => void;
};

export const postgresRunQueries: RunQueries = {
  ledgerPage: (scope, q) => withTenantDb((tx) => ledgerPageQuery(tx, scope, q)),
  ledgerIdentity: async (scope, runId) => {
    const rows = await withTenantDb((tx) =>
      ledgerIdentityQuery(tx, scope, runId),
    );
    return rows[0]?.identity ?? null;
  },
  ledgerRollups: async (scope, runIds) => {
    if (runIds.length === 0) return new Map();
    const rows = await withTenantDb((tx) =>
      ledgerRollupQuery(tx, scope, runIds),
    );
    return new Map(rows.map(({ runId, ...rollup }) => [runId, rollup]));
  },
  ledgerSeals: async (scope, runIds) => {
    if (runIds.length === 0) return new Map();
    const rows = await withTenantDb((tx) => ledgerSealQuery(tx, scope, runIds));
    return new Map(rows.map((r) => [r.runId, r.sealedAt]));
  },
  tachoPage: (scope, q) => withTenantDb((tx) => tachoPageQuery(tx, scope, q)),
  tachoSession: async (scope, publicId) => {
    const rows = await withTenantDb((tx) =>
      tachoSessionQuery(tx, scope, publicId),
    );
    return rows[0] ?? null;
  },
  tachoTouched: async (scope, sessionId) => {
    const rows = await withTenantDb((tx) =>
      tachoTouchedQuery(tx, scope, sessionId),
    );
    return rows.map((r) => r.path);
  },
};

export function defaultLiveRunsDeps(): LiveRunsDeps {
  // Construction is pure (closures over withTenantDb); nothing connects until
  // a read runs inside a tenant scope.
  const ledger = createPostgresRunStore();
  return {
    inScope: (scope, fn) =>
      runInTenantScope(
        { orgId: scope.orgId, workspaceId: scope.workspaceId },
        fn,
      ),
    store: {
      getRunByPublicId: (id) => ledger.getRunByPublicId(id),
      listRunAttempts: (id) => ledger.listRunAttempts(id),
      readAttemptEventsSince: (id, after, limit) =>
        ledger.readAttemptEventsSince(id, after, limit),
    },
    queries: postgresRunQueries,
    sumTokenUsage: sumTokenUsageByExecutionStep,
    report: (error, context) => {
      captureError({ error, source: "app", severity: "error", context });
    },
  };
}

// ---- The port -----------------------------------------------------------------------

export function createLiveRuns(deps: LiveRunsDeps): RunReadPort {
  /** Run a store read; a thrown store failure is reported and answered as the page's error. */
  async function guarded<T>(
    page: "fleet" | "run",
    method: string,
    scope: Scope,
    read: () => Promise<Read<T>>,
  ): Promise<Read<T>> {
    try {
      return await deps.inScope(scope, read);
    } catch (error) {
      deps.report(error, `live runs.${method} failed`);
      const { code, status } = PAGE_FAILURES[page].error;
      return readError(code, status);
    }
  }

  async function ledgerRunId(scope: Scope, runId: string) {
    const summary = await deps.store.getRunByPublicId(runId);
    if (!summary) return null;
    // RLS already fences the org; this also fences the workspace, and holds on
    // a stack that runs with the RLS bypass on.
    const identity = await deps.queries.ledgerIdentity(scope, summary.runId);
    return identity ? { summary, identity } : null;
  }

  const port: RunReadPort = {
    async listRuns(scope, q) {
      if (scope.workspaceId === ORG_ONLY_WORKSPACE_ID)
        return workspaceRequired();
      // Proven means a witness verdict, which nothing records yet.
      if (q.filter === "proven") return notBacked("M6", "G7");
      const cursor = q.cursor === undefined ? null : decodeRunCursor(q.cursor);
      if (q.cursor !== undefined && cursor === null) return invalidCursor();

      return guarded<RunPage>("fleet", "listRuns", scope, async () => {
        const page = {
          live: q.filter === "live",
          cursor,
          limit: RUN_PAGE_SIZE,
        };
        const [ledger, tacho] = await Promise.all([
          deps.queries.ledgerPage(scope, page),
          deps.queries.tachoPage(scope, page),
        ]);
        const merged = mergeNewestFirst<FleetItem>(
          [
            {
              items: ledger.slice(0, RUN_PAGE_SIZE).map((row) => ({
                kind: "ledger" as const,
                id: row.run.publicId,
                startedAt: (
                  row.run.startedAt ?? row.run.createdAt
                ).toISOString(),
                row,
              })),
              overflowed: ledger.length > RUN_PAGE_SIZE,
            },
            {
              items: tacho.slice(0, RUN_PAGE_SIZE).map((row) => ({
                kind: "tacho" as const,
                id: row.session.publicId,
                startedAt: row.session.startedAt.toISOString(),
                row,
              })),
              overflowed: tacho.length > RUN_PAGE_SIZE,
            },
          ],
          RUN_PAGE_SIZE,
        );

        const ledgerIds = merged.items.flatMap((item) =>
          item.kind === "ledger" ? [item.row.run.runId] : [],
        );
        const [rollups, sealed, usage] = await Promise.all([
          deps.queries.ledgerRollups(scope, ledgerIds),
          deps.queries.ledgerSeals(scope, ledgerIds),
          ledgerIds.length === 0
            ? Promise.resolve(new Map<string, TokenUsageByStepRow>())
            : deps.sumTokenUsage({
                orgId: scope.orgId,
                executionStepIds: ledgerIds,
              }),
        ]);

        const rows = [];
        for (const item of merged.items) {
          const mapped =
            item.kind === "ledger"
              ? toLedgerRunRow({
                  ...item.row,
                  rollup: rollups.get(item.row.run.runId) ?? EMPTY_ROLLUP,
                  sealedAt: sealed.get(item.row.run.runId) ?? null,
                  usage: usage.get(item.row.run.runId) ?? null,
                })
              : toTachoRunRow(item.row);
          // One run the view model cannot express makes the page not
          // expressible: a run is never dropped from Fleet to make it render.
          if (!mapped.ok) return mapped;
          rows.push(mapped.value);
        }
        return readOk({ rows, next: merged.next });
      });
    },

    async getRun(scope, runId) {
      if (scope.workspaceId === ORG_ONLY_WORKSPACE_ID)
        return workspaceRequired();
      const kind = runIdKind(runId);
      if (kind === null) return runNotFound();

      return guarded<RunDetail>("run", "getRun", scope, async () => {
        if (kind === "tacho") {
          const found = await deps.queries.tachoSession(scope, runId);
          if (!found) return runNotFound();
          const touched = await deps.queries.tachoTouched(
            scope,
            found.sessionId,
          );
          return toTachoRunDetail(found, touched);
        }
        const found = await ledgerRunId(scope, runId);
        if (!found) return runNotFound();
        const id = found.summary.runId;
        const [attempts, rollups, usage] = await Promise.all([
          deps.store.listRunAttempts(id),
          deps.queries.ledgerRollups(scope, [id]),
          deps.sumTokenUsage({ orgId: scope.orgId, executionStepIds: [id] }),
        ]);
        return toLedgerRunDetail({
          run: found.summary,
          identity: found.identity,
          rollup: rollups.get(id) ?? EMPTY_ROLLUP,
          sealedAt: latestSealAt(attempts),
          usage: usage.get(id) ?? null,
        });
      });
    },

    async framesSince(scope, runId, afterSeq, limit = 200) {
      if (scope.workspaceId === ORG_ONLY_WORKSPACE_ID)
        return workspaceRequired();
      if (!DECIMAL_CURSOR.test(afterSeq)) return invalidCursor();
      const kind = runIdKind(runId);
      if (kind === null) return runNotFound();
      // tacho frames live in ClickHouse tacho_events, which has no read seam or
      // contract yet: the run is recorded, its frames are not readable here.
      if (kind === "tacho") return notBacked("M1", "G6");
      const pageSize = Math.min(
        Math.max(Math.trunc(limit), 1),
        MAX_FRAMES_PER_READ,
      );

      return guarded<Frame[]>("run", "framesSince", scope, async () => {
        const found = await ledgerRunId(scope, runId);
        if (!found) return runNotFound();
        // run_seq starts at 1, so any cursor below it reads from the start.
        let after = BigInt(afterSeq) < 0n ? "0" : afterSeq;
        const frames: Frame[] = [];
        for (let page = 0; page < MAX_SKIPPED_EVENT_PAGES; page += 1) {
          const batch: AttemptEventReadRecord[] =
            await deps.store.readAttemptEventsSince(
              found.summary.runId,
              after,
              pageSize,
            );
          for (const event of batch) {
            const draft = toLedgerFrame(event);
            if (!draft) continue;
            // Parse = the adapter cannot hand the SSE player a shape Frame
            // does not accept, whatever the ledger's event shape becomes.
            const parsed = Frame.safeParse(draft);
            if (!parsed.success) return readError(RUN_RECORD_INVALID, 500);
            frames.push(parsed.data);
          }
          const last = batch.at(-1);
          if (frames.length > 0 || batch.length < pageSize || !last) break;
          after = last.runSeq;
        }
        return readOk(frames);
      });
    },

    // Not recorded anywhere yet: the milestone and gap come from backing.ts.
    transcript: () => Promise.resolve(notBackedForMethod("runs", "transcript")),
    runGraph: () => Promise.resolve(notBackedForMethod("runs", "runGraph")),
    contextWindow: () =>
      Promise.resolve(notBackedForMethod("runs", "contextWindow")),
    proof: () => Promise.resolve(notBackedForMethod("runs", "proof")),
  };
  return port;
}

export const liveRuns: RunReadPort = createLiveRuns(defaultLiveRunsDeps());
