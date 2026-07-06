/**
 * Nightly consolidation pipeline, per workspace.
 *
 * Extracted from the Inngest function so it can be unit-tested against a real
 * DuckDB store without the scheduler. Runs the full Phase-D flow for one
 * namespace, in the order the audit requires (distill → dedupe → promote →
 * reinforce → evict) — landmine fixes in @oxagen/engram (idempotent
 * reinforcement, deterministic distill identity, real dedupe) make each step
 * safe to re-run.
 */
import {
  type EpisodicStore,
  type Namespace,
  type MemoryRecord,
  type SemanticBody,
  type ProceduralBody,
  createRecord,
  computeSalience,
  distill,
  deduplicateSemanticRecords,
  detectPatterns,
  promotePatterns,
  ReinforcementTracker,
  DEFAULT_DISTILLATION_CONFIG,
} from "@oxagen/engram";

export interface ConsolidationCounts {
  newFacts: number;
  boostedFacts: number;
  deduped: number;
  promotedRules: number;
  reinforced: number;
  evicted: number;
}

const ZERO: ConsolidationCounts = {
  newFacts: 0,
  boostedFacts: 0,
  deduped: 0,
  promotedRules: 0,
  reinforced: 0,
  evicted: 0,
};

/** Salience floored value used to sink a semantic duplicate below the pack line. */
const DUPLICATE_SALIENCE = 0.01;

/** Provenance author stamped on records the consolidation job writes. */
const AUTHOR = "engram.consolidation";

export interface ConsolidateOptions {
  /** "Now" in unix ms (injectable for tests). */
  now: number;
  /** Only distill episodic events created at/after this unix ms. */
  since: number;
  /** Max records pulled per query. */
  batchLimit?: number;
}

/**
 * Run consolidation for a single workspace. Returns per-step counts.
 */
export async function consolidateWorkspace(
  store: EpisodicStore,
  namespace: Namespace,
  opts: ConsolidateOptions,
): Promise<ConsolidationCounts> {
  const counts: ConsolidationCounts = { ...ZERO };
  const limit = opts.batchLimit ?? 5000;
  const provenance = { author: AUTHOR, derivedFrom: [] as string[], timestamp: opts.now };

  // Recent episodic events + existing semantic facts.
  const episodic = await store.query({
    namespace,
    kinds: ["episodic"],
    after: opts.since,
    limit,
  });
  const existingFacts = await store.query({ namespace, kinds: ["semantic"], limit });

  // 1. Distill episodic → semantic (deterministic identity; offline, no LLM).
  const distillation = await distill(episodic, existingFacts, DEFAULT_DISTILLATION_CONFIG);
  for (const nf of distillation.newFacts) {
    const body = nf.fact as SemanticBody;
    const record = createRecord({
      kind: "semantic",
      namespace,
      body,
      salience: computeSalience("semantic", body),
      confidence: nf.confidence,
      provenance: { ...provenance, derivedFrom: nf.derivedFrom },
      createdAt: opts.now,
    });
    await store.append(record);
    counts.newFacts += 1;
  }
  for (const bf of distillation.boostedFacts) {
    await store.updateConfidence(bf.recordId, bf.newConfidence);
    counts.boostedFacts += 1;
  }

  // 2. Dedupe semantic facts (re-read to include the ones just written). Sink
  //    duplicates below the pack line rather than hard-deleting — content-
  //    addressed records are recoverable and decay handles cold storage.
  const semanticNow = await store.query({ namespace, kinds: ["semantic"], limit });
  const dedupe = deduplicateSemanticRecords(semanticNow);
  const seen = new Set<string>();
  for (const dup of dedupe.duplicates) {
    if (seen.has(dup.remove)) continue;
    seen.add(dup.remove);
    await store.updateSalience(dup.remove, DUPLICATE_SALIENCE);
    counts.deduped += 1;
  }

  // 3. Promote recurring successful tool sequences to procedural rules.
  const existingRules = await store.query({ namespace, kinds: ["procedural"], limit });
  const sessions = groupBySession(episodic);
  const patterns = detectPatterns(sessions);
  const candidates = promotePatterns(patterns, existingRules);
  for (const candidate of candidates) {
    const body = candidate.proposedRule as ProceduralBody;
    const record = createRecord({
      kind: "procedural",
      namespace,
      body,
      salience: computeSalience("procedural", body),
      confidence: candidate.confidence,
      provenance: { ...provenance, derivedFrom: candidate.pattern.examples },
      createdAt: opts.now,
    });
    await store.append(record);
    counts.promotedRules += 1;
  }

  // 4. Reinforcement: derive an outcome signal from stored episodic events —
  //    each event with an outcome credits the records it was derived from
  //    (causality) — then reconcile salience idempotently.
  const tracker = buildReinforcementTracker(episodic);
  const { boosted, penalized } = await tracker.applyToStore(
    store,
    (id, salience) => store.updateSalience(id, salience),
  );
  counts.reinforced = boosted + penalized;

  // 5. TTL enforcement: actually evict records whose ttl has passed.
  counts.evicted = await store.evictExpired(namespace, opts.now);

  return counts;
}

/** Group episodic events into per-session lists (session-less events share one). */
function groupBySession(events: MemoryRecord[]): MemoryRecord[][] {
  const bySession = new Map<string, MemoryRecord[]>();
  for (const e of events) {
    const key = e.namespace.session ?? "__no_session__";
    const list = bySession.get(key) ?? [];
    list.push(e);
    bySession.set(key, list);
  }
  return [...bySession.values()];
}

/**
 * Build a reinforcement tracker from stored episodic outcomes: each event with
 * a known outcome credits the records in its causality chain.
 */
function buildReinforcementTracker(events: MemoryRecord[]): ReinforcementTracker {
  const tracker = new ReinforcementTracker();
  for (const e of events) {
    const outcome = (e.body as { outcome?: string }).outcome;
    if (outcome !== "success" && outcome !== "failure") continue;
    for (const parentId of e.causality) {
      tracker.recordRetrieval(parentId);
      tracker.reinforceTurn([parentId], outcome);
    }
  }
  return tracker;
}
