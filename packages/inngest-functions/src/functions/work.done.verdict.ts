// work.done.verdict.ts: decide a done record's verdict after each stage of a
// work order, append the verdict to work.done_verdicts when it changed, and
// send work/done.verdict.
//
// The verdict follows the run. It never blocks an agent's stop.
//
// The shared contract names no table that ties a work order to its done
// record, and no store for the check results, oracle results, and signatures
// decide reads. A loader supplies all of that. The surface that registers this
// function sets the loader at startup with setDoneEvidenceLoader.
//
// A row is appended only when the verdict differs from the record's last row,
// so a stage that moves one criterion from open to held while the record stays
// pending writes nothing and sends nothing. The first verdict always lands.
import { schema, withTenantDb } from "@oxagen/database";
import { decide, lockDigest, type DoneEvidence, type DoneVerdict } from "@oxagen/done-record";
import { NonRetriableError } from "@oxagen/functions";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, sql } from "drizzle-orm";
import { createFunction } from "../create-function";
import {
  WORK_DONE_VERDICT_EVENT,
  WORK_STAGE_COMPLETED_EVENT,
  type WorkDoneVerdictEventData,
  type WorkStageCompletedEventData,
} from "../events";
import { logger } from "../logger";

/** What the loader finds for one work order. */
export interface LoadedDoneEvidence {
  /** Everything decide reads: the locked record, the evidence so far, the models, and the usage. */
  evidence: DoneEvidence;
  /** The model each stage ran, by role, as the gateway recorded it. */
  stageModels: Record<string, string>;
  /** The commit the work order's branch is at, when it has one. */
  commitSha?: string;
}

/**
 * Finds the done record for a stage's work order and the evidence gathered for
 * it. Runs inside the event's tenant scope. Returns null when the work order has
 * no locked done record.
 */
export type DoneEvidenceLoader = (data: WorkStageCompletedEventData) => Promise<LoadedDoneEvidence | null>;

let loader: DoneEvidenceLoader | null = null;

/** Set the loader this function reads evidence through. Pass null to clear it. */
export function setDoneEvidenceLoader(next: DoneEvidenceLoader | null): void {
  loader = next;
}

/** The tenant a verdict belongs to. */
export interface VerdictScope {
  orgId: string;
  workspaceId: string;
}

/** What recordDoneVerdict did. */
export type VerdictRecord =
  | { status: "unchanged"; digest: string; verdict: DoneVerdict }
  | { status: "recorded"; id: string; digest: string; verdict: DoneVerdict };

/**
 * Decide the verdict and append it to work.done_verdicts when it differs from
 * the record's last row. An advisory lock on the record serializes two stages
 * that finish at once, so both cannot append the same change.
 */
export async function recordDoneVerdict(scope: VerdictScope, loaded: LoadedDoneEvidence): Promise<VerdictRecord> {
  const outcome = decide(loaded.evidence);
  const { record } = loaded.evidence;
  // A record edited after its lock keeps the digest it was stored under, so
  // its broken verdict lands on the same history as its earlier ones.
  const digest = record.lock?.digest ?? lockDigest(record);
  const verdicts = schema.workDoneVerdicts;

  return runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`work.done_verdicts:${scope.orgId}:${scope.workspaceId}:${digest}`}, 0))`,
      );
      const [last] = await tx
        .select({ verdict: verdicts.verdict })
        .from(verdicts)
        .where(
          and(
            eq(verdicts.orgId, scope.orgId),
            eq(verdicts.workspaceId, scope.workspaceId),
            eq(verdicts.recordDigest, digest),
          ),
        )
        .orderBy(desc(verdicts.createdAt), desc(verdicts.id))
        .limit(1);
      if (last?.verdict === outcome.verdict) {
        return { status: "unchanged", digest, verdict: outcome.verdict };
      }
      const [row] = await tx
        .insert(verdicts)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          recordDigest: digest,
          verdict: outcome.verdict,
          // The column holds reason codes only. A code that names several
          // criteria appears once.
          reasons: [...new Set(outcome.reasons.map((reason) => reason.code))],
          criteria: outcome.criteria,
          stageModels: loaded.stageModels,
          commitSha: loaded.commitSha ?? null,
        })
        .returning({ id: verdicts.id });
      if (row === undefined) {
        throw new Error(`work.done_verdicts returned no row for ${digest}`);
      }
      return { status: "recorded", id: row.id, digest, verdict: outcome.verdict };
    }),
  );
}

/**
 * On each finished stage, decide the work order's done record again. When the
 * verdict changed, append it and send work/done.verdict. The event id is the
 * new row's id, so a retried step cannot send the change twice.
 */
export const [workDoneVerdict] = createFunction(
  {
    id: "work.done.verdict",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.work_order_id" },
  },
  { event: WORK_STAGE_COMPLETED_EVENT },
  async ({ event, step }) => {
    const data = event.data as unknown as WorkStageCompletedEventData;
    const load = loader;
    if (load === null) {
      throw new NonRetriableError(
        "work.done.verdict has no evidence loader. Call setDoneEvidenceLoader where the function is registered.",
      );
    }
    const scope: VerdictScope = { orgId: data.org_id, workspaceId: data.workspace_id };

    const result = await step.run("record-verdict", async (): Promise<VerdictRecord | null> => {
      const loaded = await runInTenantScope(scope, () => load(data));
      return loaded === null ? null : recordDoneVerdict(scope, loaded);
    });

    if (result === null) {
      logger.info({ workOrderId: data.work_order_id }, "work.done.verdict: the work order has no locked done record");
      return { status: "no_record" as const };
    }
    if (result.status === "unchanged") {
      return result;
    }

    const payload: WorkDoneVerdictEventData = {
      org_id: data.org_id,
      workspace_id: data.workspace_id,
      record_digest: result.digest,
      verdict: result.verdict,
    };
    await step.sendEvent("send-verdict", {
      name: WORK_DONE_VERDICT_EVENT,
      id: `work-done-verdict:${result.id}`,
      data: payload,
    });
    logger.info(
      { workOrderId: data.work_order_id, recordDigest: result.digest, verdict: result.verdict },
      "work.done.verdict: verdict changed",
    );
    return result;
  },
);
