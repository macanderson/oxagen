// agent.interjection-timeout-sweep.ts: the backstop for the durable
// interjection timeout (#3941, D8).
//
// The ingest writes a `repo_unknown` row and then sends
// `agent/interjection.raised`, which starts `agent/interjection-timeout`.
// Three things can leave that row unsettled past its deadline:
//
//   - The send fails after the row commits. The ingest logs it and returns
//     success, because failing the batch helps nothing: the host's resent
//     `control.interject` frame meets the row's raising-frame key, writes no
//     second row, and sends no event.
//   - The durable function exhausts its retries, or Inngest loses its run.
//   - The runner's clock reads behind Inngest's past the function's grace.
//
// A row left there holds the host's session with no `message` to release it,
// and writes no receipt or `agent.interjection_answered` event. Every five
// minutes this sweep finds each repository question still unsettled
// `SWEEP_AFTER_MS` after its deadline and runs the same deny step on it. The
// deny locks the row and writes its receipt only where none is recorded, so
// the sweep and a late durable run cannot both write one.
//
// The sweep does not resolve the repository. A person who answers after the
// deadline is refused, and `answer_interjection` resolves the repository
// itself for an answer given in time.
import { schema, withSystemDb } from "@oxagen/database";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";

import { createFunction } from "../create-function";
import type { AgentInterjectionRaisedEventData } from "../events";
import { interjectionTimeoutRunner } from "../lib/interjection-timeout-runner";
import { logger } from "../logger";

const ij = schema.interjections;

/** Questions settled per pass; a backlog drains a batch every five minutes. */
export const SWEEP_BATCH = 200;

/**
 * How long past its deadline a question waits for the durable timeout
 * before the sweep settles it. The function denies at the deadline and
 * again 30 seconds later, so a row still open five minutes on has lost it.
 */
export const SWEEP_AFTER_MS = 5 * 60_000;

/**
 * Repository questions whose deadline passed before `cutoff` and that the
 * deny step would still write on: nobody answered, or the host's own timeout
 * answered `deny` and the row has no receipt yet. A person's answer carries
 * a receipt, so it is never listed. Oldest deadline first, at most `limit`.
 *
 * The scan crosses tenants, so `interjections_open_idx`, which leads on the
 * org and workspace, does not serve it. The table holds only questions, and
 * the predicate keeps the scan to the few left unsettled.
 */
async function listOverdueInterjections(args: {
  cutoff: Date;
  limit: number;
}): Promise<AgentInterjectionRaisedEventData[]> {
  // tenancy: the scheduled sweep scans unsettled repository questions across all organizations; each row carries its orgId and workspaceId, and the deny runs in that tenant's scope.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        publicId: ij.publicId,
        orgId: ij.orgId,
        workspaceId: ij.workspaceId,
        expiresAt: ij.expiresAt,
      })
      .from(ij)
      .where(
        and(
          eq(ij.kind, "repo_unknown"),
          isNull(ij.receiptId),
          or(isNull(ij.answeredAt), eq(ij.path, "deny")),
          lt(ij.expiresAt, args.cutoff),
        ),
      )
      .orderBy(asc(ij.expiresAt))
      .limit(args.limit),
  );
  return rows.map((row) => ({
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    interjectionId: row.publicId,
    expiresAt: new Date(row.expiresAt).toISOString(),
  }));
}

/**
 * Every five minutes: settle each repository question the durable timeout
 * missed. Each deny runs in its own tenant transaction, so one that fails is
 * logged and left for the next pass.
 */
export const [agentInterjectionTimeoutSweep] = createFunction(
  {
    id: "agent/interjection-timeout-sweep",
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const swept = await step.run("deny-overdue", async () => {
      // A process that booted without handlers fails the step here, once.
      const runner = interjectionTimeoutRunner();
      const cutoff = new Date(Date.now() - SWEEP_AFTER_MS);
      const overdue = await listOverdueInterjections({
        cutoff,
        limit: SWEEP_BATCH,
      });
      if (overdue.length === SWEEP_BATCH)
        logger.warn(
          { batch: SWEEP_BATCH },
          "agent/interjection-timeout-sweep: the batch is full; the next pass settles the rest",
        );
      const settled: string[] = [];
      let failed = 0;
      for (const request of overdue) {
        try {
          const denied = await runner.deny(request);
          if (denied.outcome === "denied" || denied.outcome === "receipted")
            settled.push(request.interjectionId);
        } catch (err) {
          failed += 1;
          logger.warn(
            {
              err,
              orgId: request.orgId,
              workspaceId: request.workspaceId,
              interjectionId: request.interjectionId,
            },
            "agent/interjection-timeout-sweep: deny failed; the next pass retries it",
          );
        }
      }
      return { found: overdue.length, settled, failed };
    });

    if (swept.settled.length > 0)
      logger.warn(
        { interjections: swept.settled },
        "agent/interjection-timeout-sweep: settled questions the durable timeout missed",
      );
    logger.info(
      {
        found: swept.found,
        settled: swept.settled.length,
        failed: swept.failed,
      },
      "agent/interjection-timeout-sweep complete",
    );
    return {
      found: swept.found,
      settled: swept.settled.length,
      failed: swept.failed,
    };
  },
);
