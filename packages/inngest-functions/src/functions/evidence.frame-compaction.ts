// evidence.frame-compaction.ts — the monthly compaction of the evidence
// ledger's hot frames (Mission Control spec §13.3; ADR-057).
//
// Frames stay in `agent.agent_run_events` for the hot window (thirteen
// months from the seal, spec §13.2) and are then removed; the seal keeps
// `event_count`, `merkle_root`, `archive_segment_ref` and the rollup, and the
// ledger reads a compacted attempt from its archive segment. Bodies are never
// moved. The delete runs through the SECURITY DEFINER function the migration
// owns, so the app role keeps no DELETE on the event log.
//
// Runs on the 3rd of each month at 04:00 UTC, after the audit-partition
// rollover on the 1st and the tool-snapshot retention on the 2nd. Cross-tenant
// by construction: the cutoff is one rule for every organisation.
import { createFunction } from "../create-function";
import { logger } from "../logger";
import { ledgerStore } from "../lib/run-record";

/** The hot window: thirteen months, counted in calendar months from the seal. */
export const HOT_WINDOW_MONTHS = 13;

export function compactionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - HOT_WINDOW_MONTHS);
  return cutoff;
}

export const [evidenceFrameCompaction] = createFunction(
  {
    id: "evidence.frame-compaction",
    retries: 3,
    concurrency: { limit: 1 },
  },
  // Third of each month at 04:00 UTC.
  { cron: "0 4 3 * *" },
  async ({ step }) => {
    const result = await step.run("compact-sealed-attempts", async () => {
      const startMs = Date.now();
      const cutoff = compactionCutoff(new Date());
      const removed = await ledgerStore().compactSealedAttempts(cutoff);
      logger.info(
        {
          removedFrames: removed,
          cutoffISO: cutoff.toISOString(),
          durationMs: Date.now() - startMs,
        },
        "evidence.frame-compaction: hot frames compacted into their segments",
      );
      return { removed, cutoff: cutoff.toISOString() };
    });
    return result;
  },
);
