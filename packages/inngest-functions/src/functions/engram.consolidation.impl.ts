/**
 * Nightly consolidation pipeline, per workspace.
 *
 * Extracted from the Inngest function so it can be unit-tested against a real
 * DuckDB store without the scheduler. Runs the full Phase-D flow for one
 * namespace, in the order the audit requires (distill+resolve → dedupe →
 * promote → reinforce → evict → decay) — landmine fixes in @oxagen/engram
 * (idempotent reinforcement, deterministic distill identity, real dedupe)
 * make each step safe to re-run.
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
  detectContradiction,
  resolveConflict,
  computeDecayedSaliences,
  identifyEvictionCandidates,
  DEFAULT_DECAY_CONFIG,
} from "@oxagen/engram";
import { logger } from "../logger";

export interface ConsolidationCounts {
  newFacts: number;
  boostedFacts: number;
  deduped: number;
  promotedRules: number;
  reinforced: number;
  evicted: number;
  /** New facts that contradicted an existing fact and went through resolveConflict. */
  contradictions: number;
  /** Records whose persisted salience was reconciled by time-based decay this run. */
  decayed: number;
  /** Records now below the decay floor (cold tier — recoverable, not deleted). */
  coldTier: number;
}

const ZERO: ConsolidationCounts = {
  newFacts: 0,
  boostedFacts: 0,
  deduped: 0,
  promotedRules: 0,
  reinforced: 0,
  evicted: 0,
  contradictions: 0,
  decayed: 0,
  coldTier: 0,
};

/** Salience floored value used to sink a semantic duplicate below the pack line. */
const DUPLICATE_SALIENCE = 0.01;

/** Provenance author stamped on records the consolidation job writes. */
const AUTHOR = "engram.consolidation";

/** Minimum delta before a decay-reconciled salience is worth a store write. */
const DECAY_WRITE_EPSILON = 0.001;

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
  const provenance = {
    author: AUTHOR,
    derivedFrom: [] as string[],
    timestamp: opts.now,
  };

  // Recent episodic events + existing semantic facts.
  const episodic = await store.query({
    namespace,
    kinds: ["episodic"],
    after: opts.since,
    limit,
  });
  const existingFacts = await store.query({
    namespace,
    kinds: ["semantic"],
    limit,
  });

  // 1. Distill episodic → semantic (deterministic identity; offline, no LLM).
  //    distill() only matches a new fact against an EQUIVALENT existing fact
  //    (jaccard similarity, for the boost path below) — it never checks for a
  //    CONTRADICTING one, so a genuinely new fact that directly contradicts an
  //    existing high-confidence fact would otherwise land silently. Run every
  //    new fact through detectContradiction/resolveConflict (consolidation/
  //    resolve.ts) against the existing semantic facts before appending.
  const distillation = await distill(
    episodic,
    existingFacts,
    DEFAULT_DISTILLATION_CONFIG,
  );
  for (const nf of distillation.newFacts) {
    const body = nf.fact as SemanticBody;
    let confidence = nf.confidence;
    let recordBody: SemanticBody = body;

    const contradicting = existingFacts.find((ef) =>
      detectContradiction(body, ef),
    );
    if (contradicting) {
      counts.contradictions += 1;
      const conflict = resolveConflict(
        contradicting,
        body,
        nf.confidence,
        nf.derivedFrom,
      );
      if (conflict.resolution === "keep_new") {
        // The new fact wins — link it to the fact it supersedes. Both records
        // are still retained (append-only, content-addressed); nothing is
        // deleted or overwritten.
        recordBody = { ...body, supersedes: [contradicting.id] };
      } else if (conflict.resolution === "keep_existing") {
        // The existing fact wins — the new fact is still written (NEVER
        // silently dropped) but at reduced confidence, so retrieval/packing
        // naturally prefers the existing one.
        confidence = Math.min(confidence, contradicting.confidence * 0.5);
      } else if (conflict.resolution === "human_review") {
        logger.warn(
          { namespace, existingId: contradicting.id, reason: conflict.reason },
          "engram.consolidation: high-confidence contradiction needs human review",
        );
      }
      // "keep_both": append unchanged — the ambiguous case distill already
      // treats as a new fact.
    }

    const record = createRecord({
      kind: "semantic",
      namespace,
      body: recordBody,
      salience: computeSalience("semantic", recordBody),
      confidence,
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
  const semanticNow = await store.query({
    namespace,
    kinds: ["semantic"],
    limit,
  });
  const dedupe = deduplicateSemanticRecords(semanticNow);
  const seen = new Set<string>();
  for (const dup of dedupe.duplicates) {
    if (seen.has(dup.remove)) continue;
    seen.add(dup.remove);
    await store.updateSalience(dup.remove, DUPLICATE_SALIENCE);
    counts.deduped += 1;
  }

  // 3. Promote recurring successful tool sequences to procedural rules.
  const existingRules = await store.query({
    namespace,
    kinds: ["procedural"],
    limit,
  });
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

  // 6. Salience decay: reconcile persisted salience against pure time-based
  //    decay (decay.ts). Without this, `salience` only ever moves on
  //    distill/dedupe/reinforce events and never reflects the mere passage of
  //    time — a fact nobody has retrieved in months would keep its original
  //    salience forever. Runs on semantic + procedural records (the durable,
  //    retrieval-surfaced tiers) after TTL eviction so a record about to be
  //    deleted isn't wastefully decayed first. Sinks to a lower salience in
  //    place (never deletes) — the same non-destructive "cold tier" pattern
  //    as the dedupe step above.
  //
  //    Deliberately passed an EMPTY stats map rather than this run's
  //    `tracker.getStatsMap()`: decay's frequency/outcome boost is meant to
  //    reflect a record's CUMULATIVE lifetime retrieval/success history, but
  //    the tracker only has THIS run's since-window episodic events — using
  //    that window-scoped signal would make the boost swing with whatever
  //    window happens to be in play rather than the record's real history.
  //    Step 4 (reinforcement) already applies outcome-based adjustment via its
  //    own idempotent, checkpointed formula; decay here is intentionally pure
  //    time-decay of `record.salience` (whatever is currently persisted,
  //    including any adjustment step 4 just made) faded by elapsed time since
  //    `createdAt`.
  //
  //    NOTE: decay recomputes from the CURRENTLY persisted salience each run —
  //    there is no separate "pre-decay" anchor field on MemoryRecord — so two
  //    runs against an UNCHANGED `now` (e.g. a rare Inngest step retry after
  //    decay already committed) legitimately re-apply the elapsed-time
  //    multiplier a second time, same as a genuine later day would. In normal
  //    cron operation `now` strictly advances daily, and decay is the last
  //    write in this function (nothing runs after it that could throw and
  //    trigger a retry post-commit), so this is a narrow, low-severity edge
  //    rather than a practical drift risk.
  const decayCandidates = [
    ...(await store.query({ namespace, kinds: ["semantic"], limit })),
    ...(await store.query({ namespace, kinds: ["procedural"], limit })),
  ];
  const noActivity = new Map<
    string,
    { retrievals: number; successes: number }
  >();
  const decayedSaliences = computeDecayedSaliences(
    decayCandidates,
    opts.now,
    noActivity,
    DEFAULT_DECAY_CONFIG,
  );
  for (const record of decayCandidates) {
    const decayed = decayedSaliences.get(record.id);
    if (
      decayed !== undefined &&
      Math.abs(decayed - record.salience) > DECAY_WRITE_EPSILON
    ) {
      await store.updateSalience(record.id, decayed);
      counts.decayed += 1;
    }
  }
  counts.coldTier = identifyEvictionCandidates(
    decayCandidates,
    opts.now,
    noActivity,
    DEFAULT_DECAY_CONFIG,
  ).length;

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
function buildReinforcementTracker(
  events: MemoryRecord[],
): ReinforcementTracker {
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
