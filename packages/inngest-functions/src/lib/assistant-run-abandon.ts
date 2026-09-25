// assistant-run-abandon.ts: the ledger's close of an in-app assistant run
// whose process died mid-turn (#3988).
//
// The in-app assistant records every turn as a ledger run (`arun_…`) and
// seals it when the turn settles (`AssistantRun.seal` in
// `@oxagen/agent/runtime/assistant-run`). A deploy, an OOM or a crash can kill
// the process between the two, and nothing else seals a ledger run. The run
// then read as live on Fleet for good, and the nightly cost sweep never
// reached it, because it rolls up only sealed ledger runs.
//
// A live turn writes a frame before and after every reverse request the
// engine makes, and the engine gives up on a request after
// `ENGINE_REVERSE_REQUEST_TIMEOUT_MS`. So a live turn is never silent for
// long. This closes an assistant run once it has recorded nothing for
// `ASSISTANT_RUN_ABANDON_AFTER_MS`: its open attempt is sealed `abandoned`
// from the rows already on the ledger, with no terminal event and an
// unobserved tail, and the run fails with `producer_silent` as the seal's
// reason. The seal is final. A late append is refused and a late seal gets
// the abandoned seal back (ADR-173).
import type { AssistantRunSurface } from "@oxagen/agent/runtime/assistant-run";
import { ENGINE_REVERSE_REQUEST_TIMEOUT_MS } from "@oxagen/agent/runtime/governed-turn";
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import type { AbandonedRun, RunStore } from "@oxagen/run-ledger";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { logger } from "../logger";
import { ledgerStore } from "./run-record";

const runs = schema.agentRuns;

/**
 * How long an assistant run may record nothing before the sweep closes it:
 * twice the engine's deadline on one reverse request.
 *
 * A live turn's longest silence is one reverse request, and a request that
 * runs out the deadline fails the turn, which then seals its own run. The
 * second deadline is the margin. A streamed completion restarts the engine's
 * deadline on every delta batch, and a failing turn still has its seal to
 * write. While the turn's process is alive, the turn decides first.
 */
export const ASSISTANT_RUN_ABANDON_AFTER_MS =
  2 * ENGINE_REVERSE_REQUEST_TIMEOUT_MS;

/**
 * Every surface an assistant turn is admitted on. A record keyed by the
 * type, so a surface added to `AssistantRunSurface` fails the build here
 * until the sweep covers it.
 */
const ASSISTANT_SURFACES: Record<AssistantRunSurface, true> = {
  chat: true,
  "api-chat": true,
};
export const ASSISTANT_RUN_SURFACES = Object.keys(
  ASSISTANT_SURFACES,
) as AssistantRunSurface[];

/** The seal's `reason_code`: the ledger inferred the end from silence. */
export const ABANDONED_REASON_CODE = "producer_silent";

/** The seal's `sealer_worker_id`: the job that wrote it. */
export const ABANDON_SEALER_ID = "evidence.assistant-run-abandon";

/** The instant before which a run's last sign of life makes it abandoned. */
export function abandonCutoff(now: Date): Date {
  return new Date(now.getTime() - ASSISTANT_RUN_ABANDON_AFTER_MS);
}

/** The run's `error`, naming the rule that closed it. */
export function abandonedRunError(): string {
  const minutes = ASSISTANT_RUN_ABANDON_AFTER_MS / 60_000;
  return `No frame reached this run for ${minutes} minutes, so the ledger sealed it abandoned.`;
}

/** An open assistant run the scan found silent, as the close must see it. */
export interface SilentAssistantRun {
  runId: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  /** The run's open attempt, or null when it never got one. */
  attemptId: string | null;
  /** `next_run_seq` in decimal: the close's compare-and-set token. */
  nextRunSeq: string;
  lastEventAt: Date;
}

/** One workspace of an organization on a dedicated Postgres plane. */
export interface PlaneScope {
  orgId: string;
  workspaceId: string;
}

/** What one scan reads, and on which plane. */
export interface ScanArgs {
  cutoff: Date;
  limit: number;
  /** One workspace on a dedicated plane. Omitted, the shared plane. */
  scope?: PlaneScope;
  /** Organizations on a dedicated plane, left out of the shared scan. */
  excludeOrgIds?: readonly string[];
}

/**
 * When the run last showed life: the last frame its open attempt recorded,
 * else the moment the attempt opened, else the moment the run was admitted.
 * Every one is the server's clock, never the producer's `observed_at`.
 *
 * The outer columns are written qualified by hand. Drizzle renders a
 * single-table select list unqualified, and an unqualified column inside a
 * subquery binds to the subquery's own table first.
 */
const lastSignOfLife = sql<string>`coalesce(
  (SELECT e.created_at FROM agent.agent_run_events AS e
    WHERE e.attempt_id = agent_runs.active_attempt_id
      AND e.event_record_version = 2
    ORDER BY e.attempt_seq DESC
    LIMIT 1),
  (SELECT a.claimed_at FROM agent.agent_run_attempts AS a
    WHERE a.id = agent_runs.active_attempt_id),
  agent_runs.created_at
)`;

/**
 * The scan as a query, exported so its SQL can be asserted: open V2 runs on
 * an assistant surface that have shown no life since `cutoff`, oldest
 * silence first.
 */
export function silentAssistantRunsQuery(tx: Tx, args: ScanArgs) {
  const excluded = args.excludeOrgIds ?? [];
  return tx
    .select({
      runId: runs.id,
      publicId: runs.publicId,
      orgId: runs.orgId,
      workspaceId: runs.workspaceId,
      attemptId: runs.activeAttemptId,
      nextRunSeq: sql<string>`${runs.nextRunSeq}::text`,
      lastEventAt: lastSignOfLife,
    })
    .from(runs)
    .where(
      and(
        eq(runs.specVersion, 2),
        inArray(runs.status, ["pending", "running"]),
        inArray(runs.surface, ASSISTANT_RUN_SURFACES),
        // A run silent since the cutoff was admitted before it. This half is
        // the one the open-runs index (`agent_runs_v2_claim_idx`) serves.
        lt(runs.createdAt, args.cutoff),
        sql`${lastSignOfLife} < ${args.cutoff.toISOString()}::timestamptz`,
        args.scope
          ? and(
              eq(runs.orgId, args.scope.orgId),
              eq(runs.workspaceId, args.scope.workspaceId),
            )
          : undefined,
        excluded.length > 0 ? notInArray(runs.orgId, [...excluded]) : undefined,
      ),
    )
    .orderBy(asc(lastSignOfLife))
    .limit(args.limit);
}

/**
 * Open assistant runs silent since `cutoff`, at most `limit`, oldest silence
 * first. With a `scope`, the scan reads that workspace on its organization's
 * own plane. Without one it reads the shared plane, leaving out the
 * organizations in `excludeOrgIds`, whose runs live on a dedicated plane.
 */
export async function listSilentAssistantRuns(
  args: ScanArgs,
): Promise<SilentAssistantRun[]> {
  const { scope } = args;
  const rows = scope
    ? await runInTenantScope(scope, () =>
        withTenantDb((tx) => silentAssistantRunsQuery(tx, args)),
      )
    : await sharedPlaneScan(args);
  return rows.map((row) => ({
    ...row,
    nextRunSeq: String(row.nextRunSeq),
    lastEventAt: new Date(row.lastEventAt),
  }));
}

/** The shared plane's scan, across every organization it holds. */
function sharedPlaneScan(args: ScanArgs) {
  // tenancy: the scheduled sweep runs outside a tenant scope and scans every
  // organization's open runs on the shared plane. Each row carries its own
  // orgId and workspaceId, and the close writes it in that tenant's scope.
  return withSystemDb((tx) => silentAssistantRunsQuery(tx, args));
}

/**
 * Every workspace of an organization whose Postgres is a dedicated plane
 * (ADR-042). Their runs are out of the shared scan's reach, so the sweep
 * reads each one in its own scope.
 */
export async function listDedicatedPlaneScopes(): Promise<PlaneScope[]> {
  const planes = schema.dataPlanes;
  // tenancy: the scheduled sweep has to learn which planes exist before it can
  // scope anything, so this is a deliberate cross-tenant read of the control
  // plane. It selects orgId and workspaceId alone, filtered to live dedicated
  // postgres planes, and reads no tenant row; abandonSilentRun then opens each
  // workspace in its own scope.
  return withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.workspaces.orgId,
        workspaceId: schema.workspaces.id,
      })
      .from(schema.workspaces)
      .innerJoin(planes, eq(planes.orgId, schema.workspaces.orgId))
      .where(
        and(
          eq(planes.kind, "postgres"),
          eq(planes.mode, "dedicated"),
          isNull(planes.deletedAt),
        ),
      ),
  );
}

/**
 * Close one silent run in its tenant's scope. Null when the run moved since
 * the scan: its turn appended a frame or sealed, or another pass closed it
 * first. `abandonRun`'s compare-and-set decides, not this read.
 */
export async function abandonSilentRun(
  run: SilentAssistantRun,
  store: Pick<RunStore, "abandonRun">,
): Promise<AbandonedRun | null> {
  return runInTenantScope(
    { orgId: run.orgId, workspaceId: run.workspaceId },
    () =>
      store.abandonRun({
        runId: run.runId,
        attemptId: run.attemptId,
        expectedNextRunSeq: run.nextRunSeq,
        reasonCode: ABANDONED_REASON_CODE,
        error: abandonedRunError(),
        sealerId: ABANDON_SEALER_ID,
      }),
  );
}

/** A run one pass closed. Its cost is rolled up as final. */
export interface AbandonedAssistantRun {
  publicId: string;
  orgId: string;
  workspaceId: string;
}

/** What one pass over one plane did. */
export interface AbandonPass {
  found: number;
  abandoned: AbandonedAssistantRun[];
}

/**
 * One pass over one plane: list the silent runs and close each in its own
 * transaction. A run that fails to close is logged and left for the next
 * pass, and the rest go ahead.
 */
export async function abandonSilentAssistantRuns(
  args: ScanArgs,
  store: Pick<RunStore, "abandonRun"> = ledgerStore(),
): Promise<AbandonPass> {
  const silent = await listSilentAssistantRuns(args);
  const abandoned: AbandonedAssistantRun[] = [];
  for (const run of silent) {
    try {
      const closed = await abandonSilentRun(run, store);
      if (closed) {
        abandoned.push({
          publicId: run.publicId,
          orgId: run.orgId,
          workspaceId: run.workspaceId,
        });
      }
    } catch (err) {
      logger.warn(
        { err, runId: run.publicId },
        "evidence.assistant-run-abandon: close failed; the next pass retries it",
      );
    }
  }
  return { found: silent.length, abandoned };
}
