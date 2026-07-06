import { createFunction } from "../create-function";
import { createStore } from "@oxagen/engram";
import { logger } from "../logger";
import {
  consolidateWorkspace,
  type ConsolidationCounts,
} from "./engram.consolidation.impl";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nightly consolidation job: distills episodic events into semantic facts,
 * dedupes them, promotes recurring successful tool sequences into procedural
 * rules, reconciles salience from observed outcomes, and evicts TTL-expired
 * records — for every workspace with activity.
 *
 * Runs as a scheduled cron (3 AM daily).
 *
 * Idempotent: distill identity is deterministic, reinforcement converges to a
 * target (not a compounding nudge), and dedupe is content-based — so a retry or
 * an overlapping window never corrupts memory.
 */
export const [engramConsolidationRun] = createFunction(
  {
    id: "engram.consolidation.run",
    retries: 3,
    timeouts: { finish: "600s" },
  },
  { cron: "0 3 * * *" },
  async ({ step }) => {
    const store = createStore();

    try {
      const namespaces = await step.run("list-namespaces", () =>
        store.listNamespaces(),
      );

      const now = Date.now();
      const since = now - DAY_MS;

      const totals: ConsolidationCounts & { workspaces: number } = {
        workspaces: 0,
        newFacts: 0,
        boostedFacts: 0,
        deduped: 0,
        promotedRules: 0,
        reinforced: 0,
        evicted: 0,
      };

      for (const namespace of namespaces) {
        const counts = await step.run(
          `consolidate:${namespace.org}/${namespace.workspace}`,
          () => consolidateWorkspace(store, namespace, { now, since }),
        );
        totals.workspaces += 1;
        totals.newFacts += counts.newFacts;
        totals.boostedFacts += counts.boostedFacts;
        totals.deduped += counts.deduped;
        totals.promotedRules += counts.promotedRules;
        totals.reinforced += counts.reinforced;
        totals.evicted += counts.evicted;
        logger.info(
          { namespace, ...counts },
          "engram.consolidation: workspace done",
        );
      }

      logger.info(totals, "engram.consolidation.run: completed");
      return totals;
    } finally {
      await store.close();
    }
  },
);
