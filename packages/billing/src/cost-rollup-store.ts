/**
 * cost-rollup-store.ts — the reads and writes around the pure rollup
 * (./cost-rollup.ts): the run's own record from Postgres, its frames from the
 * two frame stores, and the `cost.run_totals` / `cost.daily_totals` rows.
 *
 * Everything here runs on the system connection with explicit org and
 * workspace predicates: the rollup jobs run outside a tenant scope, and a
 * derived index is rebuilt for a tenant, never read as one. Handlers read the
 * rows through withTenantDb in their own modules.
 */
import {
  readRunVerdict,
  readWitnessedRunId,
  schema,
  withSystemDb,
} from "@oxagen/database";
import {
  readModelCallFrames,
  readTachoToolCallFrames,
  type FrameRunRef,
  type ModelCallFrameRow,
} from "@oxagen/telemetry";
import {
  MODEL_CALL_EVENT_TYPES,
  TOOL_CALL_EVENT_TYPES,
} from "@oxagen/run-ledger";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import {
  dailyTotalsFromRuns,
  rollupRun,
  type CostBasis,
  type DailyTotalsRecord,
  type ModelCallFrame,
  type RunMeta,
  type RunTotalsRecord,
  type TokenCounts,
  type ToolCallFrame,
} from "./cost-rollup";
import { loadPriceBook, type PriceBook } from "./price-book";

/**
 * Both spellings of each call event. The in-app assistant writes
 * `model.engine_call_completed` / `tool.engine_call_completed`, and these
 * rollups matched only the ledger's `model.call_completed` /
 * `tool.call_completed`, so a run's turn count and its tool-name list came
 * back empty for the one producer in the tree. The registry in
 * `@oxagen/run-ledger` is the single list; see `stepKindOfEventType`.
 */
const MODEL_CALL_TYPES = [...MODEL_CALL_EVENT_TYPES];
const TOOL_CALL_TYPES = [...TOOL_CALL_EVENT_TYPES];

const runs = schema.agentRuns;
const events = schema.agentRunEvents;
const seals = schema.agentRunAttemptSeals;
const sessions = schema.tachoSessions;
const principals = schema.principals;
const totals = schema.runTotals;
const daily = schema.dailyTotals;

const centers = schema.costCenters;

/**
 * The run's cost center: the agent's label when it names a live row of the
 * organization's list, else the workspace's on the same terms, else null
 * (ADR-142). A soft-deleted label claims no new rollup, and the row's own
 * spelling is what the rollup records, so `eng-1001` on an agent reads as the
 * list's `ENG-1001`.
 */
function resolvedCostCenter(
  orgId: AnyColumn,
  agentLabel: AnyColumn,
  workspaceLabel: AnyColumn,
) {
  const live = (label: AnyColumn) =>
    sql`(select ${centers.label}::text from ${centers} where ${centers.orgId} = ${orgId} and ${centers.label} = ${label} and ${centers.deletedAt} is null limit 1)`;
  return sql<
    string | null
  >`coalesce(${live(agentLabel)}, ${live(workspaceLabel)})`;
}

/** What a rollup needs to know about a run before it reads the frames. */
interface RunSource {
  meta: RunMeta;
  frames: FrameRunRef;
}

const LEDGER_TIERS = new Set(["gateway", "harness", "observe"]);
const GRADES = new Set(["inspect", "view", "fork", "retry"]);

function tier(value: string | null): RunMeta["enforcementTier"] {
  return value !== null && LEDGER_TIERS.has(value)
    ? (value as RunMeta["enforcementTier"])
    : null;
}

function grade(value: string | null): RunMeta["replayGrade"] {
  return value !== null && GRADES.has(value)
    ? (value as RunMeta["replayGrade"])
    : null;
}

/**
 * The run's own record by public id: a V2 ledger run (`arun_…`) or a root
 * tacho session (`tse_…`). Null when neither store has it.
 */
async function loadRunSource(publicId: string): Promise<RunSource | null> {
  if (publicId.startsWith("arun_")) {
    // tenancy: the scheduled rollup job runs outside a tenant scope and finds
    // the run by its globally unique public id; the orgId it answers comes
    // from the run row, and the cost-center subquery is filtered by that orgId.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          runId: runs.id,
          orgId: runs.orgId,
          workspaceId: runs.workspaceId,
          initiatingPrincipalId: runs.initiatingPrincipalId,
          operatorKey: principals.publicId,
          agentPrincipalId: runs.agentPrincipalId,
          orgNamespace: schema.organizations.namespace,
          workspaceNamespace: schema.workspaces.namespace,
          agentSlug: schema.agents.slug,
          goal: sql<string | null>`${runs.spec}->>'goal'`,
          costCenter: resolvedCostCenter(
            runs.orgId,
            schema.agents.costCenter,
            schema.workspaces.costCenter,
          ),
          createdAt: runs.createdAt,
          startedAt: runs.startedAt,
          sealedAt: sql<Date | null>`(select max(${seals.sealedAt}) from ${seals} where ${seals.runId} = ${runs.id})`,
          turnIndexes:
            sql<number>`(select count(distinct ${events.payloadInline}->>'turn_index') from ${events} where ${events.runId} = ${runs.id} and ${inArray(events.eventType, MODEL_CALL_TYPES)})::int`.mapWith(
              Number,
            ),
          opaqueModelCalls:
            sql<number>`(select count(*) from ${events} where ${events.runId} = ${runs.id} and ${inArray(events.eventType, MODEL_CALL_TYPES)} and ${events.payloadInline} is null)::int`.mapWith(
              Number,
            ),
        })
        .from(runs)
        .innerJoin(
          schema.workspaces,
          eq(schema.workspaces.id, runs.workspaceId),
        )
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, runs.orgId),
        )
        .leftJoin(schema.agents, eq(schema.agents.id, runs.agentId))
        .leftJoin(
          principals,
          and(
            eq(principals.id, runs.initiatingPrincipalId),
            eq(principals.orgId, runs.orgId),
          ),
        )
        .where(and(eq(runs.publicId, publicId), eq(runs.specVersion, 2)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    const sealedAt =
      row.sealedAt === null
        ? null
        : new Date(row.sealedAt as unknown as string);
    return {
      meta: {
        runId: publicId,
        runSource: "ledger",
        orgId: row.orgId,
        workspaceId: row.workspaceId,
        operatorPrincipalId: row.initiatingPrincipalId,
        operatorKey: row.operatorKey,
        agentPrincipalId: row.agentPrincipalId,
        agentKey:
          row.orgNamespace && row.workspaceNamespace && row.agentSlug
            ? `${row.orgNamespace}.${row.workspaceNamespace}.${row.agentSlug}`
            : null,
        taskRef: row.goal,
        costCenter: row.costCenter,
        startedAt: row.startedAt ?? row.createdAt,
        sealedAt,
        turns: row.opaqueModelCalls === 0 ? row.turnIndexes : null,
        retries: null,
        enforcementTier: null,
        replayGrade: null,
      },
      frames: { kind: "ledger", runUuid: row.runId },
    };
  }

  if (publicId.startsWith("tse_")) {
    // tenancy: the scheduled rollup job runs outside a tenant scope and finds
    // the session by its globally unique public id; the agent join and the
    // cost-center subquery are filtered by the session's own orgId.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          sessionUuid: sessions.sessionUuid,
          orgId: sessions.orgId,
          workspaceId: sessions.workspaceId,
          agentKey: sessions.agentKey,
          agentPrincipalId: sessions.agentPrincipalId,
          initiatingPrincipalId: sessions.initiatingPrincipalId,
          operatorKey: principals.publicId,
          startedAt: sessions.startedAt,
          sealedAt: sessions.sealedAt,
          numTurns: sessions.numTurns,
          numApiRetries: sessions.numApiRetries,
          enforcementTier: sessions.enforcementTier,
          replayGrade: sessions.replayGrade,
          costCenter: resolvedCostCenter(
            sessions.orgId,
            schema.agents.costCenter,
            schema.workspaces.costCenter,
          ),
        })
        .from(sessions)
        .leftJoin(
          schema.workspaces,
          eq(schema.workspaces.id, sessions.workspaceId),
        )
        // A wrapped agent is known by its principal; the agent row, deleted or
        // not, is what carries its cost center.
        .leftJoin(
          schema.agents,
          and(
            eq(schema.agents.principalId, sessions.agentPrincipalId),
            eq(schema.agents.orgId, sessions.orgId),
          ),
        )
        .leftJoin(
          principals,
          and(
            eq(principals.id, sessions.initiatingPrincipalId),
            eq(principals.orgId, sessions.orgId),
          ),
        )
        .where(
          and(
            eq(sessions.publicId, publicId),
            isNull(sessions.parentSessionUuid),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      meta: {
        runId: publicId,
        runSource: "tacho",
        orgId: row.orgId,
        workspaceId: row.workspaceId,
        operatorPrincipalId: row.initiatingPrincipalId,
        operatorKey: row.operatorKey,
        agentPrincipalId: row.agentPrincipalId,
        agentKey: row.agentKey,
        taskRef: null,
        costCenter: row.costCenter,
        startedAt: row.startedAt,
        sealedAt: row.sealedAt,
        turns: row.numTurns,
        retries: row.numApiRetries,
        enforcementTier: tier(row.enforcementTier),
        replayGrade: grade(row.replayGrade),
      },
      frames: { kind: "tacho", rootSessionUuid: row.sessionUuid },
    };
  }
  return null;
}

/** A ledger run's tool calls: its `tool.call_completed` events; an encrypted payload names no tool. */
async function readLedgerToolCalls(args: {
  orgId: string;
  workspaceId: string;
  runUuid: string;
}): Promise<ToolCallFrame[]> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        name: sql<string | null>`${events.payloadInline}->>'capability_name'`,
      })
      .from(events)
      .where(
        and(
          eq(events.orgId, args.orgId),
          eq(events.workspaceId, args.workspaceId),
          eq(events.runId, args.runUuid),
          eq(events.eventRecordVersion, 2),
          inArray(events.eventType, TOOL_CALL_TYPES),
        ),
      ),
  );
  return rows.map((r) => ({ name: r.name }));
}

function toFrame(row: ModelCallFrameRow): ModelCallFrame {
  return {
    at: new Date(row.at),
    model: row.model,
    provider: row.provider,
    tokens: {
      input_uncached: row.inputUncached,
      cache_read: row.cacheRead,
      cache_write_5m: row.cacheWrite5m,
      cache_write_1h: row.cacheWrite1h,
      output: row.output,
      reasoning: row.reasoning,
    },
    reportedCostMicros:
      row.reportedCostMicros === null ? null : BigInt(row.reportedCostMicros),
    basis: row.basis,
  };
}

/** The reads a run rollup makes; production defaults, tests inject fakes. */
/** A tenant a run belongs to. */
type RollupScope = { orgId: string; workspaceId: string };

export interface RunRollupDeps {
  loadRunSource: (publicId: string) => Promise<RunSource | null>;
  readModelCalls: (args: {
    orgId: string;
    run: FrameRunRef;
  }) => Promise<ModelCallFrame[]>;
  readToolCalls: (source: RunSource) => Promise<ToolCallFrame[]>;
  loadPriceBook: (args: { orgId: string }) => Promise<PriceBook>;
  readCarried: (
    runId: string,
  ) => Promise<Pick<RunTotalsRecord, "accepted" | "productiveRatio"> | null>;
  /** The run's witness verdict (ADR-064), aggregated from its verdict rows. */
  readVerdict: (
    scope: RollupScope,
    runId: string,
  ) => Promise<RunTotalsRecord["verdict"]>;
  /** The worker run a witness run reported on; null for any other run. */
  readWitnessedRun: (
    scope: RollupScope,
    runId: string,
  ) => Promise<string | null>;
  write: (record: RunTotalsRecord, rolledUpAt: Date) => Promise<void>;
  now: () => Date;
}

type Row = typeof totals.$inferSelect;

/** A `cost.run_totals` row as the rollup record; the handlers read rows through this too. */
export function runTotalsRowToRecord(row: Row): RunTotalsRecord {
  return {
    runId: row.runId,
    runSource: row.runSource as RunMeta["runSource"],
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    operatorPrincipalId: row.operatorPrincipalId,
    operatorKey: row.operatorKey,
    agentPrincipalId: row.agentPrincipalId,
    agentKey: row.agentKey,
    taskRef: row.taskRef,
    costCenter: row.costCenter,
    startedAt: row.startedAt,
    sealedAt: row.sealedAt,
    turns: row.turns,
    retries: row.retries,
    enforcementTier: tier(row.enforcementTier),
    replayGrade: grade(row.replayGrade),
    steps: row.steps,
    modelCalls: row.modelCalls,
    toolCalls: row.toolCalls,
    tokens: row.tokens as TokenCounts,
    costMicros: row.costMicros,
    currency: row.currency,
    costBasis: row.costBasis as CostBasis | null,
    priceEntryIds: row.priceEntryIds,
    cacheHitRate: row.cacheHitRate === null ? null : Number(row.cacheHitRate),
    breakdown: reviveBreakdown(row.breakdown),
    verdict: row.verdict,
    accepted: row.accepted,
    productiveRatio:
      row.productiveRatio === null ? null : Number(row.productiveRatio),
  };
}

type ModelBreakdown = RunTotalsRecord["breakdown"]["models"][number];
type ModelBreakdownJson = Omit<ModelBreakdown, "costMicros" | "costByClass"> & {
  costMicros: string | null;
  costByClass: Record<keyof ModelBreakdown["costByClass"], string>;
};

/** jsonb carries the per-model costs as decimal strings; bring them back to bigint. */
function reviveBreakdown(value: unknown): RunTotalsRecord["breakdown"] {
  const raw = value as {
    models: ModelBreakdownJson[];
    tools: RunTotalsRecord["breakdown"]["tools"];
  };
  return {
    models: raw.models.map((m) => ({
      ...m,
      costMicros: m.costMicros === null ? null : BigInt(m.costMicros),
      costByClass: Object.fromEntries(
        Object.entries(m.costByClass).map(([k, v]) => [k, BigInt(v)]),
      ) as ModelBreakdown["costByClass"],
      // A row written before `hasUnpriced` existed carries no such key; the
      // only information that row has about it is whether the whole group
      // priced, so that is the fallback (never a mixed group, since a mixed
      // group was impossible before this PR seeded the first price book).
      hasUnpriced: m.hasUnpriced ?? m.costMicros === null,
    })),
    tools: raw.tools,
  };
}

function serializeBreakdown(breakdown: RunTotalsRecord["breakdown"]) {
  return {
    models: breakdown.models.map((m) => ({
      ...m,
      costMicros: m.costMicros === null ? null : m.costMicros.toString(),
      costByClass: Object.fromEntries(
        Object.entries(m.costByClass).map(([k, v]) => [k, v.toString()]),
      ),
    })),
    tools: breakdown.tools,
  };
}

/** Insert or replace the run's row; the row's identity is the run's public id. */
/**
 * Refuses an upsert that would regress a run from fully priced back to
 * incomplete for the frame set it already priced (#3271 residue G1).
 *
 * Two independent rebuilds of the same sealed run can race: `cost.run-rollup`
 * on the run's seal, and `cost.price-book-reprice` on a backdated price. Each
 * reads the price book fresh and writes unconditionally, so whichever writes
 * LAST wins regardless of which read a FRESHER book — a rebuild that started
 * before a price sync committed can still land its write after the repricer
 * already corrected the same run, silently reverting it to blank or
 * `estimated` with nothing left to notice or re-trigger a fix.
 *
 * A sealed run's frames do not change after sealing, so two rebuilds of one
 * run always see the same `modelCalls`/`toolCalls`. That makes "more
 * complete for the same frame count" a safe, one-directional ratchet: prices
 * for a past instant only ever get filled in or corrected, never revoked
 * out from under a run that already priced under them (the branch's own
 * earlier P1 fixes — a backdated removal over a shipped window is refused,
 * a same-instant list rewrite is refused once the instant has passed —
 * establish that invariant). So a write that would take a fully-priced row
 * (no unpriced model group, a real basis) back to incomplete, without the
 * frame count changing, can only be a stale read racing a fresher one, and
 * is refused rather than applied. Any other write — including one making an
 * incomplete row MORE complete, which is what the repricer and a recovered
 * catalog are for — is unaffected.
 *
 * Built lazily inside {@link upsertRunTotals} rather than at module scope:
 * a module-scope `sql` fragment referencing `totals.costBasis` evaluates
 * `totals` the moment this module loads, which throws for any caller that
 * mocks `@oxagen/database`'s schema without a full `runTotals` table (the
 * normal case for a handler test that never touches this write path).
 */
function regressesToIncomplete() {
  return sql`(
    ${totals.costBasis} IS NOT NULL
    AND ${totals.costBasis} <> 'estimated'
    AND NOT (${totals.breakdown} -> 'models' @> '[{"hasUnpriced": true}]'::jsonb)
    AND ${totals.modelCalls} = excluded.model_calls
    AND ${totals.toolCalls} = excluded.tool_calls
    AND (
      excluded.cost_basis IS NULL
      OR excluded.cost_basis = 'estimated'
      OR (excluded.breakdown -> 'models') @> '[{"hasUnpriced": true}]'::jsonb
    )
  )`;
}

/** Exported only for the write-guard's own pg-integration test. */
export async function upsertRunTotals(
  record: RunTotalsRecord,
  rolledUpAt: Date,
): Promise<void> {
  const values = {
    orgId: record.orgId,
    workspaceId: record.workspaceId,
    runId: record.runId,
    runSource: record.runSource,
    operatorPrincipalId: record.operatorPrincipalId,
    operatorKey: record.operatorKey,
    agentPrincipalId: record.agentPrincipalId,
    agentKey: record.agentKey,
    taskRef: record.taskRef,
    costCenter: record.costCenter,
    startedAt: record.startedAt,
    sealedAt: record.sealedAt,
    turns: record.turns,
    steps: record.steps,
    modelCalls: record.modelCalls,
    toolCalls: record.toolCalls,
    tokens: record.tokens,
    costMicros: record.costMicros,
    currency: record.currency,
    costBasis: record.costBasis,
    priceEntryIds: record.priceEntryIds,
    cacheHitRate:
      record.cacheHitRate === null ? null : record.cacheHitRate.toFixed(8),
    retries: record.retries,
    enforcementTier: record.enforcementTier,
    replayGrade: record.replayGrade,
    breakdown: serializeBreakdown(record.breakdown),
    verdict: record.verdict,
    rolledUpAt,
  };
  // The value columns belong to other lanes: a first insert carries what the
  // rollup read (null until those lanes write), and a rebuild leaves the row's
  // own values in place rather than replaying a stale read. The verdict is
  // rebuilt with the rest, from the run's verdict rows (ADR-064).
  const carried = {
    accepted: record.accepted,
    productiveRatio:
      record.productiveRatio === null
        ? null
        : record.productiveRatio.toFixed(8),
  };
  await withSystemDb((tx) =>
    tx
      .insert(totals)
      .values({ ...values, ...carried })
      .onConflictDoUpdate({
        target: totals.runId,
        set: values,
        setWhere: sql`NOT ${regressesToIncomplete()}`,
      }),
  );
}

async function readCarried(runId: string) {
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        accepted: totals.accepted,
        productiveRatio: totals.productiveRatio,
      })
      .from(totals)
      .where(eq(totals.runId, runId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    accepted: row.accepted,
    productiveRatio:
      row.productiveRatio === null ? null : Number(row.productiveRatio),
  };
}

const productionRunRollupDeps: RunRollupDeps = {
  loadRunSource,
  readModelCalls: async (args) =>
    (await readModelCallFrames(args)).map(toFrame),
  readToolCalls: (source) =>
    source.frames.kind === "ledger"
      ? readLedgerToolCalls({
          orgId: source.meta.orgId,
          workspaceId: source.meta.workspaceId,
          runUuid: source.frames.runUuid,
        })
      : readTachoToolCallFrames({
          orgId: source.meta.orgId,
          rootSessionUuid: source.frames.rootSessionUuid,
        }),
  loadPriceBook,
  readCarried,
  readVerdict: (scope, runId) =>
    withSystemDb((tx) => readRunVerdict(tx, scope, runId)),
  readWitnessedRun: (scope, runId) =>
    withSystemDb((tx) => readWitnessedRunId(tx, scope, runId)),
  write: upsertRunTotals,
  now: () => new Date(),
};

/**
 * Rebuild one run's `cost.run_totals` row from its frames. Returns the row,
 * or null when no store has the run. Throws when a frame store is degraded:
 * the job retries rather than writing a row built from missing frames.
 */
export async function rebuildRunTotals(
  publicId: string,
  deps: RunRollupDeps = productionRunRollupDeps,
): Promise<RunTotalsRecord | null> {
  const source = await deps.loadRunSource(publicId);
  if (!source) return null;
  const scope = {
    orgId: source.meta.orgId,
    workspaceId: source.meta.workspaceId,
  };
  const [modelCalls, toolCalls, book, carried, verdict, workerId] =
    await Promise.all([
      deps.readModelCalls({ orgId: source.meta.orgId, run: source.frames }),
      deps.readToolCalls(source),
      deps.loadPriceBook({ orgId: source.meta.orgId }),
      deps.readCarried(publicId),
      deps.readVerdict(scope, publicId),
      deps.readWitnessedRun(scope, publicId),
    ]);
  // A witness run is a run of its own whose cost belongs to the worker's
  // operator (spec §8.5 "Stamping"), so its row names that operator, and is
  // charged back to the worker's cost center for the same reason.
  const worker = workerId === null ? null : await deps.loadRunSource(workerId);
  const meta = worker
    ? {
        ...source.meta,
        operatorPrincipalId: worker.meta.operatorPrincipalId,
        operatorKey: worker.meta.operatorKey,
        costCenter: worker.meta.costCenter,
      }
    : source.meta;
  const record = rollupRun({
    meta,
    modelCalls,
    toolCalls,
    book,
    carried: {
      verdict,
      accepted: carried?.accepted ?? null,
      productiveRatio: carried?.productiveRatio ?? null,
    },
  });
  await deps.write(record, deps.now());
  return record;
}

// ── Daily rollup ──────────────────────────────────────────────────────────────

/** The bounds of one UTC day: [start, next). */
export function dayBounds(day: string): { start: Date; next: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()))
    throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  return { start, next: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Every run row of one workspace that started on `day`. */
async function readRunTotalsForDay(args: {
  orgId: string;
  workspaceId: string;
  day: string;
}): Promise<RunTotalsRecord[]> {
  const { start, next } = dayBounds(args.day);
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(totals)
      .where(
        and(
          eq(totals.orgId, args.orgId),
          eq(totals.workspaceId, args.workspaceId),
          gte(totals.startedAt, start),
          lt(totals.startedAt, next),
        ),
      )
      .orderBy(asc(totals.startedAt)),
  );
  return rows.map(runTotalsRowToRecord);
}

/** Replace the workspace-day's group rows in one transaction. */
async function replaceDailyTotals(
  args: { orgId: string; workspaceId: string; day: string },
  rows: readonly DailyTotalsRecord[],
  rolledUpAt: Date,
): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx
      .delete(daily)
      .where(
        and(
          eq(daily.orgId, args.orgId),
          eq(daily.workspaceId, args.workspaceId),
          eq(daily.day, args.day),
        ),
      );
    if (rows.length === 0) return;
    await tx.insert(daily).values(
      rows.map((r) => ({
        orgId: r.orgId,
        workspaceId: r.workspaceId,
        day: r.day,
        groupKind: r.groupKind,
        groupKey: r.groupKey,
        provider: r.provider,
        runs: r.runs,
        calls: r.calls,
        costMicros: r.costMicros,
        currency: r.currency,
        costBasis: r.costBasis,
        provenMicros: r.provenMicros,
        acceptedMicros: r.acceptedMicros,
        productiveRatio:
          r.productiveRatio === null ? null : r.productiveRatio.toFixed(8),
        tokens: r.tokens,
        rolledUpAt,
      })),
    );
  });
}

interface DailyRollupDeps {
  readRuns: typeof readRunTotalsForDay;
  write: typeof replaceDailyTotals;
  now: () => Date;
}

const productionDailyRollupDeps: DailyRollupDeps = {
  readRuns: readRunTotalsForDay,
  write: replaceDailyTotals,
  now: () => new Date(),
};

/** Rebuild one workspace-day's `cost.daily_totals` rows from its run rows. */
export async function rebuildDailyTotals(
  args: { orgId: string; workspaceId: string; day: string },
  deps: DailyRollupDeps = productionDailyRollupDeps,
): Promise<DailyTotalsRecord[]> {
  const runRows = await deps.readRuns(args);
  const rows = dailyTotalsFromRuns(runRows);
  await deps.write(args, rows, deps.now());
  return rows;
}

// ── Sweeps ────────────────────────────────────────────────────────────────────

/**
 * Sealed runs with no row, or a row older than their seal: what the nightly
 * job rolls up so a seal whose event was lost is still counted. Root tacho
 * sessions and V2 ledger runs, oldest seal first, at most `limit`.
 */
export async function listRunsAwaitingRollup(args: {
  limit: number;
}): Promise<string[]> {
  return withSystemDb(async (tx) => {
    const tacho = await tx
      .select({ publicId: sessions.publicId, sealedAt: sessions.sealedAt })
      .from(sessions)
      .leftJoin(totals, eq(totals.runId, sessions.publicId))
      .where(
        and(
          isNull(sessions.parentSessionUuid),
          sql`${sessions.sealedAt} IS NOT NULL`,
          or(
            isNull(totals.id),
            sql`${totals.rolledUpAt} < ${sessions.sealedAt}`,
          ),
        ),
      )
      .orderBy(asc(sessions.sealedAt))
      .limit(args.limit);
    const ledger = await tx
      .select({
        publicId: runs.publicId,
        sealedAt: sql<Date>`max(${seals.sealedAt})`.mapWith(seals.sealedAt),
      })
      .from(runs)
      .innerJoin(seals, eq(seals.runId, runs.id))
      .leftJoin(totals, eq(totals.runId, runs.publicId))
      .where(eq(runs.specVersion, 2))
      // run_id is unique on run_totals, so the joined rolled_up_at is one
      // value per run and may sit in the GROUP BY.
      .groupBy(runs.publicId, totals.rolledUpAt)
      .having(
        or(
          isNull(totals.rolledUpAt),
          sql`max(${seals.sealedAt}) > ${totals.rolledUpAt}`,
        ),
      )
      .orderBy(sql`max(${seals.sealedAt})`)
      .limit(args.limit);
    return [...tacho, ...ledger]
      .sort(
        (a, b) => (a.sealedAt?.getTime() ?? 0) - (b.sealedAt?.getTime() ?? 0),
      )
      .slice(0, args.limit)
      .map((r) => r.publicId);
  });
}

/** One row of {@link listRunsWithIncompleteCost}, and the cursor for the page after it. */
export interface IncompleteCostRun {
  runId: string;
  /** RFC 3339, millisecond precision. */
  startedAt: string;
}

/**
 * Rolled-up runs whose cost is incomplete: `cost_basis` null (no frame
 * priced at all), `estimated` (some class had no price), or a total that
 * left a wholly unpriced frame out. Oldest first.
 *
 * These are the runs a newly written price can still change. The nightly
 * sweep does not reach them: it lists runs whose totals are missing or older
 * than their seal, and one of these has a `rolled_up_at` after its seal
 * already. On a fresh installation runs seal before the first price-book
 * sync, and a sync that ran with a catalog down leaves that catalog's models
 * unpriced until it recovers, so without this their cost stayed blank for
 * ever.
 *
 * The third case is why the basis alone is not enough. `rollupRun` skips a
 * frame the book prices nothing of and whose record reports no figure: it
 * adds no cost and no basis, so a run with one priced frame beside it keeps
 * the priced frame's basis, `gateway_observed` or `client_attested`, over a
 * total that is missing the other call. Reading the basis alone would leave
 * that run out of every later recovery and understate its run and daily
 * cost for ever. The skipped frame's model group is the durable record of
 * it: {@link rollupRun} sets `hasUnpriced: true` on any model group holding
 * at least one unpriced call, and jsonb containment finds those rows. A
 * group's `costMicros` alone is not enough here, because it stays non-null
 * whenever any OTHER call to that same model priced — a run with one priced
 * and one unpriced call to one model reads as fully costed on that field
 * even though it is not. This predicate checks both fields: `hasUnpriced`
 * for a row this function's current form wrote, and `costMicros: null` for
 * one an earlier form wrote before `hasUnpriced` existed (which can only be
 * a wholly-unpriced group, since a mixed group was impossible before this
 * PR seeded the first price book).
 *
 * `after` is the last row of the previous page. A run whose model no source
 * prices stays incomplete after its rebuild, so a caller that re-read the
 * head of the list would see the same rows again and never reach the rest.
 * The cursor compares at millisecond precision because it travels as an ISO
 * string, which drops the microseconds Postgres keeps.
 */
export async function listRunsWithIncompleteCost(args: {
  limit: number;
  after?: IncompleteCostRun;
}): Promise<IncompleteCostRun[]> {
  const startedMs = sql<Date>`date_trunc('milliseconds', ${totals.startedAt})`;
  const incomplete = or(
    isNull(totals.costBasis),
    eq(totals.costBasis, "estimated"),
    sql`${totals.breakdown} -> 'models' @> '[{"hasUnpriced": true}]'::jsonb`,
    // A row rolled up by a version of this function before `hasUnpriced`
    // existed still carries `costMicros: null` on a wholly-unpriced group
    // (it can never carry a mixed group, since the price book this PR seeds
    // did not exist yet), so this keeps such a row selected until its next
    // rebuild writes the new field.
    sql`${totals.breakdown} -> 'models' @> '[{"costMicros": null}]'::jsonb`,
  );
  return withSystemDb(async (tx) => {
    const rows = await tx
      .select({ runId: totals.runId, startedAt: totals.startedAt })
      .from(totals)
      .where(
        args.after
          ? and(
              incomplete,
              sql`(${startedMs}, ${totals.runId}) > (${args.after.startedAt}::timestamptz, ${args.after.runId})`,
            )
          : incomplete,
      )
      .orderBy(asc(startedMs), asc(totals.runId))
      .limit(args.limit);
    return rows.map((r) => ({
      runId: r.runId,
      startedAt: r.startedAt.toISOString(),
    }));
  });
}

/** The workspaces that have run rows starting on `day`. */
export async function listWorkspacesWithRuns(args: {
  day: string;
}): Promise<{ orgId: string; workspaceId: string }[]> {
  const { start, next } = dayBounds(args.day);
  return withSystemDb((tx) =>
    tx
      .selectDistinct({ orgId: totals.orgId, workspaceId: totals.workspaceId })
      .from(totals)
      .where(and(gte(totals.startedAt, start), lt(totals.startedAt, next))),
  );
}

/** One row of {@link listRunsWithUnassignedCostCenter}, and the cursor for the page after it. */
export interface UnassignedCostCenterRun {
  runId: string;
  orgId: string;
  workspaceId: string;
  /** RFC 3339, millisecond precision. */
  startedAt: string;
}

/**
 * Rolled-up runs charged to no cost center whose agent, or failing that
 * whose workspace, now names a live label (ADR-142). Oldest first.
 *
 * These are the rows a rebuild would move out of the unassigned line: a
 * `cost.run_totals` row written before the column existed, or before the
 * agent or workspace was charged to a label. The seal-time rollup and the
 * nightly sweep never revisit them, because their `rolled_up_at` postdates
 * their seal, so `db:backfill-cost-centers` lists them here and asks the
 * rollup job to rebuild each one. A row whose label was cleared again since
 * is not listed: the coalesce below is the same resolution the rollup makes,
 * so a run this lists is a run the rebuild will charge.
 *
 * The agent is found by its principal, the way the tacho rollup finds it, so
 * a ledger run and a wrapped run resolve alike, and a deleted agent's row
 * still carries its label. Only rows with a null `cost_center` are listed:
 * moving a run from one label to another is a policy ADR-142 has not
 * decided, and a backfill that did it silently would rewrite a closed
 * month's statement.
 *
 * `after` is the last row of the previous page, at millisecond precision for
 * the reason {@link listRunsWithIncompleteCost} gives. `orgId` narrows the
 * pass to one organization.
 */
export async function listRunsWithUnassignedCostCenter(args: {
  limit: number;
  after?: UnassignedCostCenterRun;
  orgId?: string;
}): Promise<UnassignedCostCenterRun[]> {
  const startedMs = sql<Date>`date_trunc('milliseconds', ${totals.startedAt})`;
  const resolved = resolvedCostCenter(
    totals.orgId,
    schema.agents.costCenter,
    schema.workspaces.costCenter,
  );
  // tenancy: the backfill runs outside a tenant scope and reads every
  // organization's run rows, oldest first, or one organization's when asked;
  // each joined label is filtered by the row's own orgId inside
  // resolvedCostCenter, so no row reads another organization's list.
  return withSystemDb(async (tx) => {
    const rows = await tx
      .select({
        runId: totals.runId,
        orgId: totals.orgId,
        workspaceId: totals.workspaceId,
        startedAt: totals.startedAt,
      })
      .from(totals)
      .leftJoin(schema.workspaces, eq(schema.workspaces.id, totals.workspaceId))
      .leftJoin(
        schema.agents,
        and(
          eq(schema.agents.principalId, totals.agentPrincipalId),
          eq(schema.agents.orgId, totals.orgId),
        ),
      )
      .where(
        and(
          isNull(totals.costCenter),
          sql`${resolved} is not null`,
          args.orgId === undefined ? undefined : eq(totals.orgId, args.orgId),
          args.after === undefined
            ? undefined
            : sql`(${startedMs}, ${totals.runId}) > (${args.after.startedAt}::timestamptz, ${args.after.runId})`,
        ),
      )
      .orderBy(asc(startedMs), asc(totals.runId))
      .limit(args.limit);
    return rows.map((r) => ({
      runId: r.runId,
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      startedAt: r.startedAt.toISOString(),
    }));
  });
}
