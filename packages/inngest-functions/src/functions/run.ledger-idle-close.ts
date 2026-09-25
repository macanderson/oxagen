import { ledgerIdleCutoff, listIdleLedgerAttempts } from "@oxagen/run-ledger";
import { createFunction } from "../create-function";
import { logger } from "../logger";
import {
  closeIdleLedgerAttempt,
  type ClosedLedgerRun,
} from "../lib/ledger-idle-close";
import { ledgerStore } from "../lib/run-record";

/** Attempts closed per pass; a backlog drains a batch every quarter hour. */
const CLOSE_BATCH = 500;

/**
 * Scans per pass. A pass that meets attempts it cannot close scans again past
 * them, up to this many times, so they cannot fill every batch. It also bounds
 * the step when every close fails.
 */
const MAX_SCANS = 4;

/**
 * Every fifteen minutes: seal the ledger attempts with no event for twelve
 * hours as `abandoned`, and roll up each closed run's cost (#3988, ADR-180).
 *
 * A ledger run seals when its producer calls `sealAttempt`. When the process
 * dies mid-turn, nothing does, so the run read as live on Fleet for good and
 * its cost was never rolled up. The close and why it is final are in
 * `../lib/ledger-idle-close.ts`.
 *
 * Each attempt is sealed in its own transaction and tenant scope, so one that
 * fails is logged and left for the next pass. The scan is oldest first, so an
 * attempt that fails every pass would stay at the head of every batch. Each
 * further scan in a pass leaves out the attempts the pass already tried, and
 * the completion log counts the failures, so such a backlog shows in
 * monitoring rather than only as one warning per attempt. Each closed run sends
 * `cost/run.sealed`, the event a wrapped session's seal sends, so its cost
 * reads final rather than as an estimate.
 */
export const [runLedgerIdleClose] = createFunction(
  {
    id: "run.ledger-idle-close",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const closed = await step.run("close-idle-attempts", async () => {
      const cutoff = ledgerIdleCutoff(new Date());
      const store = ledgerStore();
      const out: ClosedLedgerRun[] = [];
      const tried: string[] = [];
      let failed = 0;
      for (let scan = 0; scan < MAX_SCANS && out.length < CLOSE_BATCH; scan++) {
        const limit = CLOSE_BATCH - out.length;
        const idle = await listIdleLedgerAttempts({
          cutoff,
          limit,
          exclude: [...tried],
        });
        for (const attempt of idle) {
          tried.push(attempt.attemptId);
          try {
            const done = await closeIdleLedgerAttempt(attempt, store);
            if (done) out.push(done);
          } catch (err) {
            failed += 1;
            logger.warn(
              { err, runId: attempt.runPublicId },
              "run.ledger-idle-close: close failed; the next pass retries it",
            );
          }
        }
        // A short page means nothing idle is left beyond what was tried.
        if (idle.length < limit) break;
      }
      return { found: tried.length, failed, closed: out };
    });

    if (closed.closed.length > 0) {
      await step.sendEvent(
        "request-rollups",
        closed.closed.map((run) => ({
          name: "cost/run.sealed",
          data: {
            runId: run.runPublicId,
            orgId: run.orgId,
            workspaceId: run.workspaceId,
          },
        })),
      );
    }

    logger.info(
      {
        found: closed.found,
        failed: closed.failed,
        closed: closed.closed.length,
      },
      "run.ledger-idle-close complete",
    );
    return {
      found: closed.found,
      failed: closed.failed,
      closed: closed.closed.length,
    };
  },
);
