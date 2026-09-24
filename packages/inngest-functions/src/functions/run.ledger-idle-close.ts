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
 * Every fifteen minutes: seal the ledger attempts with no event for twelve
 * hours as `abandoned`, and roll up each closed run's cost (#3988, ADR-173).
 *
 * A ledger run seals when its producer calls `sealAttempt`. When the process
 * dies mid-turn, nothing does, so the run read as live on Fleet for good and
 * its cost was never rolled up. The close and why it is final are in
 * `../lib/ledger-idle-close.ts`.
 *
 * Each attempt is sealed in its own transaction and tenant scope, so one that
 * fails is logged and left for the next pass. Each closed run sends
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
      const idle = await listIdleLedgerAttempts({ cutoff, limit: CLOSE_BATCH });
      const store = ledgerStore();
      const out: ClosedLedgerRun[] = [];
      for (const attempt of idle) {
        try {
          const done = await closeIdleLedgerAttempt(attempt, store);
          if (done) out.push(done);
        } catch (err) {
          logger.warn(
            { err, runId: attempt.runPublicId },
            "run.ledger-idle-close: close failed; the next pass retries it",
          );
        }
      }
      return { found: idle.length, closed: out };
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
      { found: closed.found, closed: closed.closed.length },
      "run.ledger-idle-close complete",
    );
    return { found: closed.found, closed: closed.closed.length };
  },
);
