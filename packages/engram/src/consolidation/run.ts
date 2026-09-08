/**
 * Phase D, as one pass over one store.
 *
 * Every piece of the maintenance half was implemented and none of it was
 * called: `evictExpired`, `updateSalience`, `identifyEvictionCandidates` and
 * `computeDecayedSaliences` had no caller anywhere outside their own tests, so
 * memories accumulated monotonically and salience stayed frozen at whatever
 * value it was given on creation. The system meant to let useful memories float
 * up and noise sink down did neither (#1418).
 *
 * This is the missing schedule's body. It is deliberately dull: it reads what
 * the store already knows, computes with the pure functions that already
 * existed, and writes back a bounded number of rows.
 *
 * ## What it does, and what it does not
 *
 * It evicts TTL-expired records and reconciles salience from observed use.
 * Those are the two the store exposes an operation for.
 *
 * It does NOT deduplicate or promote, and that is a missing store operation
 * rather than a missing decision. `deduplicateSemanticRecords` returns records
 * to REMOVE, and the store has no delete except `evictExpired`, which deletes
 * by TTL and nothing else. Adding one would let a maintenance pass destroy a
 * memory a person asked to keep, which is a call for whoever owns the data, not
 * for this function. `promotePatterns` needs an `ActionPattern[]` and nothing in
 * this package mines them. Both are named here so the gap is a decision waiting
 * on someone rather than an omission nobody can see.
 *
 * ## Why the write volume is capped
 *
 * The first pass over a store that has never been consolidated will find every
 * record's salience stale, because nothing has ever written one. Uncapped, that
 * is one UPDATE per record in the workspace, in one burst, on whatever machine
 * happens to run the schedule. The cap spends its budget on the largest
 * corrections first, so an interrupted or throttled pass still moves the
 * records that were most wrong, and the next pass continues from there.
 */
import {
  computeDecayedSaliences,
  DEFAULT_DECAY_CONFIG,
  type DecayConfig,
} from "../decay";
import type { Namespace } from "../types";
import type { EpisodicStore } from "../store/episodic";

export interface ConsolidationConfig {
  decay: DecayConfig;
  /**
   * Most salience writes one pass makes per namespace. Bounds the first run
   * over a store that has never been consolidated.
   */
  maxSalienceWrites: number;
  /**
   * Smallest salience change worth a write. Below this the row is left alone:
   * rewriting a record to move its salience by a thousandth costs a write and
   * buys nothing any reader can tell apart.
   */
  salienceEpsilon: number;
  /** Most records examined per namespace per pass. */
  scanLimit: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  decay: DEFAULT_DECAY_CONFIG,
  maxSalienceWrites: 500,
  salienceEpsilon: 0.01,
  scanLimit: 5000,
};

export interface NamespaceReport {
  namespace: Namespace;
  /** TTL-expired records deleted. */
  evicted: number;
  /** Records read and considered. */
  scanned: number;
  /** Salience rows written. */
  written: number;
  /** Wanted a write, did not get one because the cap was spent. */
  deferred: number;
  /** Changed by less than `salienceEpsilon`. */
  unchanged: number;
}

export interface ConsolidationReport {
  /** Unix ms the pass was run for. */
  now: number;
  namespaces: NamespaceReport[];
  evicted: number;
  scanned: number;
  written: number;
  deferred: number;
}

/**
 * Run one consolidation pass over every namespace the store holds records for.
 *
 * Failure in one namespace does not abandon the rest: a workspace whose store
 * rows are malformed should not stop every other workspace from being
 * maintained, and the alternative is a single bad row freezing the whole
 * schedule forever. The error is rethrown only if EVERY namespace failed, which
 * is the shape that means the store itself is the problem.
 */
export async function runConsolidation(opts: {
  store: EpisodicStore;
  now: number;
  config?: Partial<ConsolidationConfig>;
  /** Called once per namespace that threw, so a host can log it. */
  onError?: (namespace: Namespace, err: unknown) => void;
}): Promise<ConsolidationReport> {
  const config: ConsolidationConfig = {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    ...opts.config,
    decay: opts.config?.decay ?? DEFAULT_CONSOLIDATION_CONFIG.decay,
  };

  const namespaces = await opts.store.listNamespaces();
  const reports: NamespaceReport[] = [];
  let failures = 0;

  for (const namespace of namespaces) {
    try {
      reports.push(
        await consolidateNamespace(opts.store, namespace, opts.now, config),
      );
    } catch (err) {
      failures++;
      opts.onError?.(namespace, err);
    }
  }

  if (namespaces.length > 0 && failures === namespaces.length) {
    throw new Error(
      `[engram] consolidation failed for all ${failures} namespace(s) — the store itself is unhealthy`,
    );
  }

  return {
    now: opts.now,
    namespaces: reports,
    evicted: sum(reports, (r) => r.evicted),
    scanned: sum(reports, (r) => r.scanned),
    written: sum(reports, (r) => r.written),
    deferred: sum(reports, (r) => r.deferred),
  };
}

async function consolidateNamespace(
  store: EpisodicStore,
  namespace: Namespace,
  now: number,
  config: ConsolidationConfig,
): Promise<NamespaceReport> {
  // Eviction first: a record whose TTL has passed should not be read, scored,
  // or written to on its way out.
  const evicted = await store.evictExpired(namespace, now);

  const records = await store.query({ namespace, limit: config.scanLimit });
  const stats = await store.readDecayStats(namespace);
  const targets = computeDecayedSaliences(records, now, stats, config.decay);

  // Largest correction first, so a capped pass moves the records that are most
  // wrong rather than whichever ones the store happened to return first.
  const pending = records
    .map((r) => {
      const target = targets.get(r.id);
      return target === undefined
        ? null
        : { id: r.id, target, delta: Math.abs(target - r.salience) };
    })
    .filter(
      (x): x is { id: string; target: number; delta: number } => x !== null,
    )
    .sort((a, b) => b.delta - a.delta);

  let written = 0;
  let deferred = 0;
  let unchanged = 0;

  for (const item of pending) {
    if (item.delta < config.salienceEpsilon) {
      unchanged++;
      continue;
    }
    if (written >= config.maxSalienceWrites) {
      deferred++;
      continue;
    }
    await store.updateSalience(
      item.id,
      item.target,
      stats.get(item.id)?.lastRetrievedAt,
    );
    written++;
  }

  return {
    namespace,
    evicted,
    scanned: records.length,
    written,
    deferred,
    unchanged,
  };
}

function sum<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((acc, item) => acc + of(item), 0);
}
