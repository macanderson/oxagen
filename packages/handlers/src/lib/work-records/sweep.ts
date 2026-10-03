// sweep.ts: the hourly pass that records what a lost event left out of a
// send (ADR-251).
//
// A send's results reach it as events, and two of them can be lost for good:
//
//   - `cost/run.sealed` is sent once, best effort, when a run seals. When it
//     is lost, the send keeps a linked run with no end, and withdraw, return,
//     and close stay refused. The sweep finds each open send whose linked run
//     sealed and has no `run_ended`, and records the end through
//     `recordRunEnded`, the function the event's step calls.
//   - GitHub does not redeliver a failed `pull_request` delivery. When one is
//     lost, a human merge or a close without merging never reaches the send,
//     and the item never moves on. The sweep reads the pull request again for
//     each open send whose run ended, or that was accepted, and that has no
//     merge or close yet.
//
// Every fact carries the dedupe key the event path writes, so a send an event
// did reach records nothing twice. Each pass reads a bounded batch per
// workspace, and the next hour reads the rest.
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, exists, gt, inArray, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logger } from "../../logger";
import { githubEvidenceReader } from "./evidence";
import { type ResultDeps, recordRunEnded, recordSendEvidence } from "./results";
import type { WorkScope } from "./store";

/** The most sealed runs one pass records per workspace. */
const SWEEP_RUN_BATCH = 50;

/** The most sends one pass reads from GitHub per workspace. Each read is up to three GitHub calls. */
const SWEEP_SEND_BATCH = 25;

/**
 * A run sealed this recently is left to its own event. The event usually
 * lands within seconds, and recording the end twice would read the run's pull
 * requests from GitHub twice.
 */
export const SWEEP_SEAL_GRACE_MS = 15 * 60_000;

/** What one workspace's pass recorded. Counts only, so a durable step's output stays JSON. */
export interface WorkOrderSweepResult {
  /** Sends that recorded the end of a run whose seal event was lost. */
  sendsEnded: number;
  /** Sends whose pull request the pass read again. */
  sendsRead: number;
  /** Facts those reads recorded. */
  factsRecorded: number;
  /** Runs and sends the pass could not record. The next pass tries them again. */
  failed: number;
}

/** A send the pass reads from GitHub again. */
interface WaitingSend {
  itemId: string;
  orderId: string;
}

const DEFAULT_DEPS: ResultDeps = { reader: githubEvidenceReader, now: () => new Date() };

const orders = schema.workOrders;
const facts = schema.workItemFacts;
const sessions = schema.tachoSessions;

/**
 * The workspaces with an open send that a run linked. Only these can hold a
 * run end or a pull request the sweep would record.
 */
export async function listWorkOrderSweepScopes(): Promise<WorkScope[]> {
  const linked = alias(facts, "linked");
  // tenancy: the scheduled sweep lists workspaces across all orgs (global), and each pass then reads only its own orgId and workspaceId in tenant scope.
  return withSystemDb((tx) =>
    tx
      .selectDistinct({ orgId: orders.orgId, workspaceId: orders.workspaceId })
      .from(orders)
      .where(
        and(
          isNull(orders.closedAt),
          exists(
            tx
              .select({ id: linked.id })
              .from(linked)
              .where(and(eq(linked.orderId, orders.id), eq(linked.kind, "run_linked"))),
          ),
        ),
      ),
  );
}

/**
 * The runs linked to an open send that sealed before `sealedBefore` and whose
 * send has no `run_ended`, oldest seal first.
 */
async function sealedRunsWithNoEnd(tx: Tx, scope: WorkScope, sealedBefore: Date): Promise<string[]> {
  const linked = alias(facts, "linked");
  const ended = alias(facts, "ended");
  const rows = await tx
    .selectDistinct({ runId: linked.runId, sealedAt: sessions.sealedAt })
    .from(orders)
    .innerJoin(linked, and(eq(linked.orderId, orders.id), eq(linked.kind, "run_linked")))
    .innerJoin(
      sessions,
      and(eq(sessions.orgId, scope.orgId), eq(sessions.workspaceId, scope.workspaceId), eq(sessions.publicId, linked.runId)),
    )
    .where(
      and(
        eq(orders.orgId, scope.orgId),
        eq(orders.workspaceId, scope.workspaceId),
        isNull(orders.closedAt),
        isNotNull(sessions.sealedAt),
        lt(sessions.sealedAt, sealedBefore),
        notExists(
          tx
            .select({ id: ended.id })
            .from(ended)
            .where(and(eq(ended.orderId, orders.id), eq(ended.kind, "run_ended"))),
        ),
      ),
    )
    .orderBy(sessions.sealedAt)
    .limit(SWEEP_RUN_BATCH);
  return rows.flatMap((row) => (row.runId === null ? [] : [row.runId]));
}

/**
 * The open sends with a pull request whose run ended, or that were accepted,
 * and that hold no merge or close. A merge or close counts until the run links
 * another pull request after it. The batch is random, so a workspace with more
 * sends than one pass reads still has each one read within a few passes.
 */
async function sendsWaitingOnTheirPullRequest(tx: Tx, scope: WorkScope): Promise<WaitingSend[]> {
  const linkedPr = alias(facts, "linked_pr");
  const finished = alias(facts, "finished");
  const prEnd = alias(facts, "pr_end");
  const relinked = alias(facts, "relinked");
  return tx
    .select({ itemId: orders.itemId, orderId: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.orgId, scope.orgId),
        eq(orders.workspaceId, scope.workspaceId),
        isNull(orders.closedAt),
        exists(
          tx
            .select({ id: linkedPr.id })
            .from(linkedPr)
            .where(and(eq(linkedPr.orderId, orders.id), eq(linkedPr.kind, "pr_linked"))),
        ),
        exists(
          tx
            .select({ id: finished.id })
            .from(finished)
            .where(and(eq(finished.orderId, orders.id), inArray(finished.kind, ["run_ended", "accepted"]))),
        ),
        notExists(
          tx
            .select({ id: prEnd.id })
            .from(prEnd)
            .where(
              and(
                eq(prEnd.orderId, orders.id),
                inArray(prEnd.kind, ["merged", "pr_closed"]),
                notExists(
                  tx
                    .select({ id: relinked.id })
                    .from(relinked)
                    .where(
                      and(
                        eq(relinked.orderId, orders.id),
                        eq(relinked.kind, "pr_linked"),
                        gt(relinked.occurredAt, prEnd.occurredAt),
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(sql`random()`)
    .limit(SWEEP_SEND_BATCH);
}

/**
 * One workspace's pass: record the end of each sealed run whose event was
 * lost, then read again each send that waits on its pull request. Both lists
 * are read before anything is recorded, so a send whose run end this pass
 * records is not read twice: `recordRunEnded` already read its pull requests.
 * One run or send that fails is counted and logged, and the pass goes on.
 */
export async function sweepWorkOrderResults(scope: WorkScope, deps: ResultDeps = DEFAULT_DEPS): Promise<WorkOrderSweepResult> {
  const sealedBefore = new Date(deps.now().getTime() - SWEEP_SEAL_GRACE_MS);
  const { runs, sends } = await runInTenantScope(scope, () =>
    withTenantDb(async (tx) => ({
      runs: await sealedRunsWithNoEnd(tx, scope, sealedBefore),
      sends: await sendsWaitingOnTheirPullRequest(tx, scope),
    })),
  );
  const result: WorkOrderSweepResult = { sendsEnded: 0, sendsRead: 0, factsRecorded: 0, failed: 0 };
  for (const runId of runs) {
    try {
      result.sendsEnded += await recordRunEnded(scope, runId, deps);
    } catch (err) {
      result.failed += 1;
      logger.warn({ err, workspaceId: scope.workspaceId, runId }, "work order sweep: could not record a sealed run's end");
    }
  }
  for (const send of sends) {
    try {
      // The same read and record as a pull request a run names. It skips a
      // send that ended since the list was read. It reads and writes through
      // withTenantDb, so it runs in the workspace's scope.
      result.factsRecorded += await runInTenantScope(scope, () =>
        recordSendEvidence(scope, send.itemId, send.orderId, deps.reader, deps.now()),
      );
      result.sendsRead += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn({ err, workspaceId: scope.workspaceId, orderId: send.orderId }, "work order sweep: could not record a send's pull request");
    }
  }
  return result;
}
