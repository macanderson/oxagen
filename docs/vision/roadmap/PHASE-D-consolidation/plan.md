# Phase D: Consolidation & Learning

> The loop that turns "a log of what happened" into "knowledge and skills."
> Background processing that makes the agent smarter over time.

---

## Overview

Phase D builds the consolidation pipeline — the background "sleep" job that asynchronously distills episodic events into durable knowledge, scores salience, applies decay, and promotes recurring successful patterns into procedural memory. This is what makes the agent get *better and faster* at a codebase over time instead of just accumulating data.

After this phase, high-value memories surface more reliably in `compile()`, noise decays away, and the agent automatically learns rules from its own successful behavior.

---

## Prerequisites

- **Phase B complete**: `compile()` working, retrieval engines operational
- Episodic store accumulating events (Phase A write path flowing)
- Multiple agent sessions have run (data to consolidate)
- Inngest operational for background jobs (`packages/inngest-functions`)
- Skills system has embedding index (for procedural promotion comparison)

---

## Parallel Tracks

### Track 1: Salience Model (Agent 1)

**Goal**: Score every memory write for importance, then decay scores over time based on a value function (not LRU).

**Deliverables**:
- `packages/engram/src/salience.ts` — Salience scoring (write-time + dynamic)
- `packages/engram/src/decay.ts` — Exponential decay with value-based eviction
- `packages/engram/src/reinforcement.ts` — Outcome-based score adjustment

**Implementation**:

```typescript
// packages/engram/src/salience.ts

export interface SalienceSignals {
  novelty: number;           // 0–1: how different from existing memories
  goalRelevance: number;     // 0–1: how relevant to the current task
  surprise: number;          // 0–1: prediction error (unexpected outcome)
  explicitPin: boolean;      // User said "remember this"
  outcomeWeight: number;     // From reinforcement: did using this lead to success?
}

/**
 * Write-time salience heuristic. Fast (no model call), runs on every remember().
 * Produces a score 0.0–1.0 that determines initial retrieval priority.
 */
export function computeWriteSalience(signals: SalienceSignals): number {
  const weights = {
    novelty: 0.25,
    goalRelevance: 0.30,
    surprise: 0.20,
    outcomeWeight: 0.25,
  };

  let score =
    weights.novelty * signals.novelty +
    weights.goalRelevance * signals.goalRelevance +
    weights.surprise * signals.surprise +
    weights.outcomeWeight * signals.outcomeWeight;

  // Explicit pin overrides: minimum 0.8 salience
  if (signals.explicitPin) score = Math.max(score, 0.8);

  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * Novelty signal: how different is this from the N most recent memories
 * in the same namespace? Uses embedding cosine distance.
 */
export async function computeNovelty(
  embedding: number[],
  recentEmbeddings: number[][],
): Promise<number> {
  if (recentEmbeddings.length === 0) return 1.0; // First memory = maximally novel
  const similarities = recentEmbeddings.map((e) => cosineSimilarity(embedding, e));
  const maxSimilarity = Math.max(...similarities);
  return 1.0 - maxSimilarity; // High similarity = low novelty
}
```

**Decay function**:

```typescript
// packages/engram/src/decay.ts

export interface DecayConfig {
  halfLife: number;           // Milliseconds until salience halves (default: 7 days)
  minSalience: number;       // Below this, eligible for eviction (default: 0.05)
  frequencyBoost: number;    // Multiplier per retrieval (default: 1.1)
  outcomeBoost: number;      // Multiplier per successful outcome (default: 1.3)
}

/**
 * Compute effective salience at a given time.
 * salience(t) = base_salience * decay(t) * frequency_boost * outcome_boost
 *
 * NOT pure time decay — value-based. Frequently-used, outcome-positive
 * memories resist decay. Unused memories fade faster.
 */
export function effectiveSalience(
  record: MemoryRecord,
  now: number,
  retrievalCount: number,
  successCount: number,
  config: DecayConfig,
): number {
  const age = now - record.createdAt;
  const timeDecay = Math.pow(0.5, age / config.halfLife);
  const freqBoost = Math.pow(config.frequencyBoost, Math.min(retrievalCount, 10));
  const outBoost = Math.pow(config.outcomeBoost, Math.min(successCount, 5));

  return record.salience * timeDecay * freqBoost * outBoost;
}

/**
 * Identify records eligible for eviction (below minimum salience).
 * These move to cold tier, not deleted — recoverable via engram.recall().
 */
export function identifyEvictionCandidates(
  records: MemoryRecord[],
  now: number,
  config: DecayConfig,
): MemoryRecord[] {
  return records.filter(
    (r) => effectiveSalience(r, now, 0, 0, config) < config.minSalience,
  );
}
```

**Reinforcement** (outcome feedback loop):

```typescript
// packages/engram/src/reinforcement.ts

/**
 * When a memory is retrieved by compile() and the turn it fed succeeded:
 * bump its outcome score. Repeatedly-useless memories decay faster.
 *
 * Called by the agent runtime after each turn resolves.
 */
export async function reinforceMemory(
  recordId: string,
  outcome: "success" | "failure",
  store: SemanticStore,
): Promise<void> {
  const record = await store.getById(recordId);
  if (!record) return;

  if (outcome === "success") {
    // Boost: this memory contributed to success
    await store.updateSalience(recordId, record.salience * 1.1);
    await store.incrementRetrievalSuccess(recordId);
  } else {
    // Penalize slightly: this memory was retrieved but didn't help
    await store.updateSalience(recordId, record.salience * 0.95);
  }
}
```

**Tests**:
- Write-time salience produces scores in [0.0, 1.0] for all inputs
- Explicit pin always produces salience ≥ 0.8
- Decay reduces salience over time (property: salience(t+Δ) < salience(t) if no retrieval)
- Reinforcement boosts frequently-successful memories
- Eviction candidates have effective salience below threshold

**Estimated effort**: 5–6 days

---

### Track 2: Consolidation Pipeline (Agent 2)

**Goal**: Background Inngest job that distills episodic events into semantic memories, deduplicates, and flags conflicts.

**Deliverables**:
- `packages/engram/src/consolidation/distill.ts` — Episodic → semantic extraction
- `packages/engram/src/consolidation/dedup.ts` — Semantic deduplication
- `packages/engram/src/consolidation/resolve.ts` — Conflict detection and resolution
- `packages/inngest-functions/src/functions/engram.consolidation.run.ts` — Inngest function

**Distillation process**:

```typescript
// packages/engram/src/consolidation/distill.ts

export interface DistillationResult {
  newFacts: SemanticBody[];              // Extracted durable facts
  updatedFacts: { id: string; confidence: number }[];  // Confidence adjustments
  conflicts: ConflictRecord[];           // Contradictions found
  evictionCandidates: string[];          // Records below salience threshold
}

/**
 * Distill a batch of episodic events into semantic facts.
 *
 * Process:
 * 1. Cluster episodic events by topic/entity (embedding similarity)
 * 2. For each cluster, extract the durable fact (using a small model)
 * 3. Check if the fact already exists (content-address dedup)
 * 4. If exists: boost confidence (seen again = more likely true)
 * 5. If new: create semantic record with initial confidence
 * 6. If contradicts existing: flag as conflict
 */
export async function distillEpisodic(
  events: MemoryRecord[],
  existingFacts: MemoryRecord[],
  config: DistillationConfig,
): Promise<DistillationResult> {
  // Cluster events by embedding similarity
  const clusters = clusterByEmbedding(events, config.clusterThreshold);

  const newFacts: SemanticBody[] = [];
  const updatedFacts: { id: string; confidence: number }[] = [];
  const conflicts: ConflictRecord[] = [];

  for (const cluster of clusters) {
    // Extract the durable fact from the cluster
    const fact = await extractFact(cluster, config);

    // Check against existing facts
    const existing = findMatchingFact(fact, existingFacts);

    if (existing) {
      if (contradicts(fact, existing)) {
        // Conflict: both kept with provenance
        conflicts.push({
          existingId: existing.id,
          newFact: fact,
          evidence: cluster.map((e) => e.id),
        });
      } else {
        // Reinforcement: same fact seen again → boost confidence
        updatedFacts.push({
          id: existing.id,
          confidence: Math.min(1.0, existing.confidence + 0.1),
        });
      }
    } else {
      newFacts.push(fact);
    }
  }

  return { newFacts, updatedFacts, conflicts, evictionCandidates: [] };
}
```

**Conflict resolution**:

```typescript
// packages/engram/src/consolidation/resolve.ts

export interface ConflictRecord {
  existingId: string;
  newFact: SemanticBody;
  evidence: string[];          // Episodic event IDs supporting the new fact
  resolution?: "keep_existing" | "keep_new" | "keep_both" | "human_review";
}

/**
 * Resolution policy:
 * - If confidence of new > existing + threshold: prefer new, lower existing confidence
 * - If confidence similar: keep both with provenance (human review flag)
 * - NEVER silently overwrite — both facts retained until resolved
 * - High-confidence conflicts escalate to human review
 */
export function resolveConflict(
  existing: MemoryRecord,
  newFact: SemanticBody,
  newConfidence: number,
  threshold: number = 0.3,
): ConflictRecord["resolution"] {
  if (newConfidence > existing.confidence + threshold) return "keep_new";
  if (existing.confidence > newConfidence + threshold) return "keep_existing";
  return "keep_both"; // Ambiguous — keep both, flag for review
}
```

**Inngest function**:

```typescript
// packages/inngest-functions/src/functions/engram.consolidation.run.ts

export const engramConsolidation = inngest.createFunction(
  { id: "engram-consolidation-run", name: "Engram Consolidation" },
  { cron: "0 3 * * *" },  // Run nightly at 3 AM (configurable)
  async ({ step }) => {
    // 1. Get unprocessed episodic events (since last consolidation)
    const events = await step.run("fetch-events", async () => {
      return store.getUnconsolidated(namespace, { limit: 1000 });
    });

    // 2. Distill into semantic facts
    const result = await step.run("distill", async () => {
      const existingFacts = await store.getSemanticFacts(namespace);
      return distillEpisodic(events, existingFacts, config);
    });

    // 3. Write new facts
    await step.run("write-facts", async () => {
      for (const fact of result.newFacts) {
        await engram.assert(fact, 0.6, { author: "consolidation", derivedFrom: events.map(e => e.id), timestamp: Date.now() });
      }
    });

    // 4. Update confidences
    await step.run("update-confidence", async () => {
      for (const update of result.updatedFacts) {
        await store.updateConfidence(update.id, update.confidence);
      }
    });

    // 5. Apply decay + eviction
    await step.run("decay", async () => {
      const candidates = identifyEvictionCandidates(await store.getAllRecords(namespace), Date.now(), decayConfig);
      await store.moveToCoId(candidates.map(c => c.id));
    });

    // 6. Mark events as consolidated
    await step.run("mark-consolidated", async () => {
      await store.markConsolidated(events.map(e => e.id));
    });

    return { factsCreated: result.newFacts.length, conflicts: result.conflicts.length };
  },
);
```

**Tests**:
- Distillation produces semantic facts from episodic clusters
- Dedup: same fact from two event clusters → one semantic record (confidence boosted)
- Conflicts: contradicting facts → both retained with provenance
- Idempotency: running consolidation twice on same events produces same result
- Integration: Inngest function completes successfully on test data

**Estimated effort**: 8–10 days

---

### Track 3: Procedural Promotion (Agent 3)

**Goal**: Detect recurring successful patterns in agent behavior and promote them to procedural memory (rules/skills).

**Deliverables**:
- `packages/engram/src/consolidation/promote.ts` — Pattern detection and promotion
- `packages/engram/src/consolidation/patterns.ts` — Pattern matching on episodic sequences
- Integration with `packages/skills` — Promoted rules become skill candidates

**Pattern detection**:

```typescript
// packages/engram/src/consolidation/patterns.ts

export interface ActionPattern {
  sequence: string[];           // Ordered list of tool/action names
  context: string;             // When this pattern was applied (embedding)
  successCount: number;        // Times this led to success
  failureCount: number;        // Times this led to failure
  successRate: number;         // successCount / (successCount + failureCount)
  lastSeen: number;            // Unix ms
  examples: string[];          // Episodic event IDs showing this pattern
}

/**
 * Detect recurring action sequences in episodic events.
 *
 * Algorithm:
 * 1. Extract tool_call sequences from episodic events, grouped by session
 * 2. Find repeated subsequences across sessions (n-gram extraction)
 * 3. Filter by success rate threshold (> 70%)
 * 4. Filter by minimum occurrence count (> 3 times)
 * 5. Return as promotion candidates
 */
export function detectPatterns(
  sessions: SessionEvent[][],
  config: PatternConfig,
): ActionPattern[] {
  const sequences = sessions.map(extractToolSequences);
  const ngrams = findCommonSubsequences(sequences, config.minLength, config.maxLength);
  
  return ngrams
    .filter((p) => p.successRate >= config.minSuccessRate)
    .filter((p) => p.successCount >= config.minOccurrences)
    .sort((a, b) => b.successRate * b.successCount - a.successRate * a.successCount);
}
```

**Promotion to procedural memory**:

```typescript
// packages/engram/src/consolidation/promote.ts

export interface PromotionCandidate {
  pattern: ActionPattern;
  proposedRule: ProceduralBody;
  confidence: number;
  reason: string;
}

/**
 * Promote successful patterns to procedural memory.
 *
 * A pattern is promoted when:
 * - Success rate > 80%
 * - Occurred > 5 times
 * - Not already captured by an existing skill/rule
 * - The context is generalizable (not too specific to one file/task)
 */
export async function promotePatterns(
  patterns: ActionPattern[],
  existingRules: MemoryRecord[],
  config: PromotionConfig,
): Promise<PromotionCandidate[]> {
  const candidates: PromotionCandidate[] = [];

  for (const pattern of patterns) {
    // Check if already captured
    const alreadyExists = existingRules.some(
      (r) => isPatternCaptured(pattern, r),
    );
    if (alreadyExists) continue;

    // Check promotion thresholds
    if (pattern.successRate < config.minSuccessRate) continue;
    if (pattern.successCount < config.minPromotionCount) continue;

    // Generate the rule
    const rule = await generateRule(pattern);
    candidates.push({
      pattern,
      proposedRule: rule,
      confidence: pattern.successRate,
      reason: `Pattern seen ${pattern.successCount} times with ${(pattern.successRate * 100).toFixed(0)}% success`,
    });
  }

  return candidates;
}
```

**Skills integration**:
- Promoted rules are written as Engram procedural records (not files initially)
- If a rule proves stable over 30+ days, propose it as a `.skill.md` file
- The proposal shows: rule text, success rate, example sessions, contexts where it applies
- Human approval required to persist as a filesystem skill (no auto-write to `.skill.md`)

**Tests**:
- Pattern detection finds repeated sequences in test session data
- Promotion respects threshold (only high success rate, high occurrence)
- Already-captured patterns are not re-promoted
- Promoted rules are retrievable by the context compiler
- Integration: end-to-end from episodic events → pattern → promoted rule

**Estimated effort**: 6–8 days

---

### Track 4: Skills Evolution (Agent 4)

**Goal**: Make existing skills retrievable by relevance (not all-at-once injection) and integrate with the consolidation pipeline.

**Deliverables**:
- `packages/skills/src/embedding-index.ts` — Pre-computed embeddings for all skills
- `packages/skills/src/relevance-retrieval.ts` — Retrieve skills by task relevance
- `packages/engram/src/retrieval/procedural.ts` — Procedural memory retrieval engine
- Modified: `packages/agent/src/runtime/materialize-tools.ts` — Use relevance-based skill injection

**Skill embedding index**:

```typescript
// packages/skills/src/embedding-index.ts

export interface SkillIndex {
  slug: string;
  embedding: number[];       // Pre-computed from description + body
  appliesTo: string[];       // Extracted keywords/patterns
  tokenCost: number;         // Tokens if injected fully
}

/**
 * Build embedding index for all loaded skills.
 * Runs at registry load time (once per daemon start).
 */
export async function buildSkillIndex(skills: Skill[]): Promise<SkillIndex[]> {
  return Promise.all(
    skills.map(async (skill) => ({
      slug: skill.slug,
      embedding: await embedText(`${skill.name}: ${skill.description}\n${skill.body}`),
      appliesTo: extractAppliesTo(skill.body),
      tokenCost: countTokens(skill.body),
    })),
  );
}
```

**Relevance-based injection** (replaces all-at-once loading):

```typescript
// packages/engram/src/retrieval/procedural.ts

/**
 * Procedural retrieval engine for the context compiler.
 * Returns skills/rules ranked by relevance to the current task.
 *
 * This replaces the current behavior of loading ALL skills into context.
 * Only task-relevant skills are injected, saving tokens for other content.
 */
export class ProceduralRetrievalEngine implements RetrievalEngine {
  name = "procedural";

  async retrieve(query: RetrievalQuery): Promise<RetrievalCandidate[]> {
    const taskEmbedding = await embedText(query.taskDescription);

    // 1. Get pinned rules (always included)
    const pinned = await getPinnedRules(query.namespace);

    // 2. Retrieve relevant skills by embedding similarity
    const relevantSkills = await retrieveByEmbedding(taskEmbedding, skillIndex, { limit: 5 });

    // 3. Retrieve promoted procedural records
    const promotedRules = await retrieveProceduralRecords(query.namespace, taskEmbedding);

    // 4. Combine, score, and return
    return [...pinned, ...relevantSkills, ...promotedRules]
      .map((r) => ({ record: r, score: r.relevance, source: "pinned" as const, tokenCost: r.tokenCost }))
      .sort((a, b) => b.score - a.score);
  }
}
```

**Tests**:
- Skills with embeddings are retrievable by task relevance
- Irrelevant skills are NOT included in context (token savings)
- Pinned/critical skills always appear regardless of relevance
- Promoted procedural records appear alongside filesystem skills
- Token savings: average 40% reduction in procedural section tokens

**Estimated effort**: 5–6 days

---

## Deliverables Checklist

- [ ] Write-time salience scoring on all `engram.remember()` calls
- [ ] Exponential decay with value-based eviction
- [ ] Reinforcement signal from successful turn outcomes
- [ ] Consolidation Inngest function (`engram.consolidation.run`)
- [ ] Episodic → semantic distillation
- [ ] Conflict detection (contradicting facts flagged, both retained)
- [ ] Procedural promotion (successful patterns → rules)
- [ ] Skills embedding index (pre-computed at load time)
- [ ] Relevance-based skill retrieval (not all-at-once injection)
- [ ] Procedural retrieval engine integrated into `compile()`

---

## Success Criteria

| Metric | Target |
|---|---|
| High-value memory retrieval frequency | Top-salience records retrieved 3x more often than random |
| Decay effectiveness | 50% of low-salience records below threshold after 14 days |
| Consolidation throughput | Process 1000 episodic events in < 30s |
| Conflict detection rate | > 90% of contradictions flagged (no silent overwrites) |
| Pattern detection precision | > 70% of promoted rules are genuinely useful |
| Skill token savings | 40% reduction in procedural section tokens |
| Retrieval precision improvement | +10% vs Phase B baseline after 30 days of use |

---

## Dependencies on Other Phases

| Depends On | Details |
|---|---|
| Phase B | Context compiler must be working (consolidation improves its inputs) |
| Phase A | Episodic store must be accumulating events to consolidate |

| Depended On By | Details |
|---|---|
| Phase E | Blackboard needs salience for multi-agent memory ranking |
| Phase F | Eval harness measures consolidation impact on retrieval quality |

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Distillation produces low-quality facts | Medium | Start conservative (high threshold); human review for first 100 facts |
| Pattern detection has too many false positives | Medium | High occurrence threshold (>5); require >80% success rate |
| Decay too aggressive (useful memories lost) | Low | Decay to cold tier (recoverable), not delete; tune half-life |
| Consolidation job too expensive (model calls) | Medium | Use cheapest model tier; batch processing; run nightly only |
| Promoted rules conflict with existing skills | Low | Check against skill index before promotion; human approval for persistence |

---

## Files Created / Modified

### Created
| File | Purpose |
|---|---|
| `packages/engram/src/salience.ts` | Write-time salience scoring |
| `packages/engram/src/decay.ts` | Exponential value-based decay |
| `packages/engram/src/reinforcement.ts` | Outcome feedback loop |
| `packages/engram/src/consolidation/distill.ts` | Episodic → semantic |
| `packages/engram/src/consolidation/dedup.ts` | Semantic deduplication |
| `packages/engram/src/consolidation/resolve.ts` | Conflict resolution |
| `packages/engram/src/consolidation/promote.ts` | Procedural promotion |
| `packages/engram/src/consolidation/patterns.ts` | Pattern detection |
| `packages/engram/src/retrieval/procedural.ts` | Procedural retrieval engine |
| `packages/inngest-functions/src/functions/engram.consolidation.run.ts` | Inngest job |
| `packages/skills/src/embedding-index.ts` | Skill embeddings |
| `packages/skills/src/relevance-retrieval.ts` | Relevance-based skill selection |

### Modified
| File | Change |
|---|---|
| `packages/agent/src/runtime/materialize-tools.ts` | Use relevance-based skills |
| `packages/engram/src/api/remember.ts` | Add salience computation |
| `packages/engram/src/compiler/compile.ts` | Add procedural retrieval engine |
| `packages/inngest-functions/src/client.ts` | Register consolidation function |
