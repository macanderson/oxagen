// evidence.frame-compaction.ts — the monthly compaction of the evidence
// ledger's hot frames (Mission Control spec §13.3; ADR-058).
//
// Frames stay in `agent.agent_run_events` for the hot window (thirteen
// months from the seal, spec §13.2) and are then removed; the seal keeps
// `event_count`, `merkle_root`, `archive_segment_ref` and the rollup, and the
// ledger reads a compacted attempt from its archive segment. Bodies are never
// moved. The delete runs through the SECURITY DEFINER function the migration
// owns, which holds the window as a constant, so the app role keeps no DELETE
// on the event log and no caller chooses the cutoff.
//
// Runs on the 3rd of each month at 04:00 UTC, after the audit-partition
// rollover on the 1st and the tool-snapshot retention on the 2nd. Cross-tenant
// by construction: the window is one rule for every organisation.
import { createFunction } from "../create-function";
import { logger } from "../logger";
import { ledgerStore } from "../lib/run-record";

export const [evidenceFrameCompaction] = createFunction(
  {
    id: "evidence.frame-compaction",
    retries: 3,
    concurrency: { limit: 1 },
  },
  // Third of each month at 04:00 UTC.
  { cron: "0 4 3 * *" },
  async ({ step }) => {
    return step.run("compact-sealed-attempts", async () => {
      const startMs = Date.now();
      const removed = await ledgerStore().compactSealedAttempts();
      logger.info(
        { removedFrames: removed, durationMs: Date.now() - startMs },
        "evidence.frame-compaction: hot frames compacted into their segments",
      );
      return { removed };
    });
  },
);
