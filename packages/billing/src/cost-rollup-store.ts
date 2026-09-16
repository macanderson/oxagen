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
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
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

const runs = schema.agentRuns;
const events = schema.agentRunEvents;
const seals = schema.agentRunAttemptSeals;
const sessions = schema.tachoSessions;
const principals = schema.principals;
const totals = schema.runTotals;
const daily = schema.dailyTotals;

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
          createdAt: runs.createdAt,
          startedAt: runs.startedAt,
          sealedAt: sql<Date | null>`(select max(${seals.sealedAt}) from ${seals} where ${seals.runId} = ${runs.id})`,
          turnIndexes:
            sql<number>`(select count(distinct ${events.payloadInline}->>'turn_index') from ${events} where ${events.runId} = ${runs.id} and ${events.eventType} = 'model.call_completed')::int`.mapWith(
              Number,
            ),
          opaqueModelCalls:
            sql<number>`(select count(*) from ${events} where ${events.runId} = ${runs.id} and ${events.eventType} = 'model.call_completed' and ${events.payloadInline} is null)::int`.mapWith(
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
        })
        .from(sessions)
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
          eq(events.eventType, "tool.call_completed"),
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
async function upsertRunTotals(
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
      .onConflictDoUpdate({ target: totals.runId, set: values }),
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
  // operator (spec §8.5 "Stamping"), so its row names that operator.
  const worker = workerId === null ? null : await deps.loadRunSource(workerId);
  const meta = worker
    ? {
        ...source.meta,
        operatorPrincipalId: worker.meta.operatorPrincipalId,
        operatorKey: worker.meta.operatorKey,
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
