import { createFunction } from "../create-function";
import { logger } from "../logger";
import {
  closeIdleSession,
  idleCutoff,
  listIdleSessions,
  type ClosedSession,
} from "../lib/tacho-idle-close";

/** Sessions closed per pass; a backlog drains a batch every quarter hour. */
const CLOSE_BATCH = 500;

/**
 * Every fifteen minutes: close the wrapped sessions whose run has sent
 * nothing for twelve hours, and roll up each closed run's cost (#3980).
 *
 * Before this, nothing on the server ever ended a session: a run sealed only
 * when its host sent `agent_stop`, so a harness whose process stayed alive or
 * a host that stopped reporting left its run reading as running for good. The
 * close and why it can be overruled are in `../lib/tacho-idle-close.ts`.
 *
 * Each session is closed in its own transaction and its own tenant scope, so
 * one that fails is logged and left for the next pass. A closed root sends
 * `cost/run.sealed`, the event the host's own seal sends, so its cost reads
 * final rather than as an estimate; a closed subagent's frames are its
 * root's, and need no event of their own.
 */
export const [tachoSessionIdleClose] = createFunction(
  {
    id: "tacho.session-idle-close",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const closed = await step.run("close-idle-sessions", async () => {
      const now = new Date();
      const cutoff = idleCutoff(now);
      const idle = await listIdleSessions({ cutoff, limit: CLOSE_BATCH });
      const out: ClosedSession[] = [];
      for (const session of idle) {
        try {
          const done = await closeIdleSession(session, cutoff, now);
          if (done) out.push(done);
        } catch (err) {
          logger.warn(
            { err, sessionId: session.publicId },
            "tacho.session-idle-close: close failed; the next pass retries it",
          );
        }
      }
      return { found: idle.length, closed: out };
    });

    const roots = closed.closed.filter((session) => session.isRoot);
    if (roots.length > 0) {
      await step.sendEvent(
        "request-rollups",
        roots.map((run) => ({
          name: "cost/run.sealed",
          data: {
            runId: run.publicId,
            orgId: run.orgId,
            workspaceId: run.workspaceId,
          },
        })),
      );
    }

    logger.info(
      {
        found: closed.found,
        closed: closed.closed.length,
        runs: roots.length,
      },
      "tacho.session-idle-close complete",
    );
    return {
      found: closed.found,
      closed: closed.closed.length,
      runs: roots.length,
    };
  },
);
