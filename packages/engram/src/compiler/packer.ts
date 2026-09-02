/**
 * Knapsack packer — budget-constrained context packing that maximizes
 * task-value per token.
 *
 * Greedy algorithm with diversity constraints. Guarantees, in priority order:
 * - Budget is NEVER exceeded — this is the invariant everything else yields to
 * - Pinned procedural rules are placed FIRST, ahead of every retrieved
 *   candidate. They are not unconditional: if the pinned set alone overflows
 *   the budget, the lowest-salience rules are dropped and counted in
 *   `pinnedTruncated` rather than breaking the budget invariant
 * - Higher value-per-token records are preferred
 * - No single source/tool dominates the window
 */
import type { MemoryRecord } from "../types";
import type { RetrievalCandidate } from "../retrieval/types";
import { compressRecord, type CompressedItem } from "./compress";
import { countTokens } from "./tokenizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenBudget {
  /** Total token budget for the entire context window. */
  total: number;
  reserved: {
    /** System prompt (fixed). */
    system: number;
    /** Pinned procedural rules. */
    procedural: number;
    /** Available for retrieved content. */
    volatile: number;
    /** Working memory / recent events. */
    working: number;
  };
}

export interface PackerInput {
  /** Candidates sorted by fused score. */
  candidates: RetrievalCandidate[];
  /** Token budget. */
  budget: TokenBudget;
  /** Always-included pinned records (salience=1.0 procedural). */
  pinnedRecords: MemoryRecord[];
  /** Max records from the same provenance.tool or body.domain. */
  diversityConstraint: number;
  /** Model ID for token counting. */
  modelId: string;
}

export interface PackResult {
  /** Records included at full text. */
  included: MemoryRecord[];
  /** Records compressed to summary + handle. */
  compressed: CompressedItem[];
  /** Records that didn't fit. */
  evicted: MemoryRecord[];
  /** Token usage breakdown. */
  tokenUsage: TokenUsage;
  /**
   * How many pinned procedural records were dropped because the pinned set
   * alone exceeded the budget. Normally 0 — a non-zero value means even
   * MUST-include rules had to be truncated (lowest-salience first) to keep the
   * budget invariant, which the caller should surface.
   */
  pinnedTruncated: number;
}

export interface TokenUsage {
  system: number;
  procedural: number;
  volatile: number;
  working: number;
  total: number;
  budgetRemaining: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Minimum score to be considered for compression (below this → evict). */
const COMPRESSION_FLOOR = 0.15;

/**
 * Extract a diversity key from a candidate for the diversity constraint.
 * Groups by provenance.tool or body.domain.
 */
function diversityKey(record: MemoryRecord): string {
  if (record.provenance.tool) return `tool:${record.provenance.tool}`;
  const body = record.body as Record<string, unknown>;
  if (body.domain) return `domain:${body.domain}`;
  if (body.event) return `event:${body.event}`;
  return `kind:${record.kind}`;
}

/**
 * Real per-record token cost for budget math. `RetrievalCandidate.tokenCost` is
 * a chars/4 estimate produced by the engines, which under-counts token-dense
 * code bodies and lets the greedy loop overspend. We recount the serialized
 * body with the model's real tokenizer so the budget invariant holds. Using the
 * full JSON body is a conservative upper bound on the (often shorter/truncated)
 * rendered text, so the window can never exceed budget.
 */
function recordTokenCost(record: MemoryRecord, modelId: string): number {
  return countTokens(JSON.stringify(record.body), modelId);
}

/**
 * Pack candidates into a budget-constrained context window.
 *
 * Invariant guaranteed on return: `tokenUsage.total <= budget.total` (so
 * `budgetRemaining >= 0`). Pinned procedural rules are included first; if the
 * pinned set alone (plus the fixed system/working reservations) would exceed
 * the budget, the lowest-salience pinned rules are truncated last and counted
 * in `pinnedTruncated`.
 */
export function pack(input: PackerInput): PackResult {
  const { candidates, budget, pinnedRecords, diversityConstraint, modelId } =
    input;

  const included: MemoryRecord[] = [];
  const compressed: CompressedItem[] = [];
  const evicted: MemoryRecord[] = [];

  const systemTokens = budget.reserved.system;
  const workingTokens = budget.reserved.working;

  // Step 1: Fit pinned procedural rules under the real budget. They are
  // MUST-include, but they cannot be allowed to blow the budget — so if the
  // pinned set overflows, drop the lowest-salience rules first (truncate last).
  const pinnedBudget = Math.max(0, budget.total - systemTokens - workingTokens);
  const pinnedBySalience = [...pinnedRecords].sort(
    (a, b) => b.salience - a.salience,
  );
  let proceduralTokens = 0;
  let pinnedTruncated = 0;
  for (const record of pinnedBySalience) {
    const cost = recordTokenCost(record, modelId);
    if (proceduralTokens + cost <= pinnedBudget) {
      proceduralTokens += cost;
      included.push(record);
    } else {
      // Doesn't fit even at max priority — this is the truncation case.
      evicted.push(record);
      pinnedTruncated += 1;
    }
  }
  const includedPinnedIds = new Set(included.map((r) => r.id));

  // Step 2: Remaining budget for retrieved volatile content, after the fixed
  // system/working reservations AND the actual pinned cost.
  const availableBudget = Math.max(
    0,
    budget.total - systemTokens - workingTokens - proceduralTokens,
  );
  let usedTokens = 0;

  // Step 3: Sort candidates by value-per-token (greedy knapsack). Cost is the
  // real tokenizer count, not the engine's chars/4 estimate.
  const ranked = candidates
    .filter((c) => !includedPinnedIds.has(c.record.id)) // Skip already-included pinned
    .map((c) => {
      const cost = recordTokenCost(c.record, modelId);
      return { ...c, cost, vpt: cost > 0 ? c.score / cost : c.score };
    })
    .sort((a, b) => b.vpt - a.vpt);

  // Step 4: Greedy pack with diversity constraint
  const diversityCounts = new Map<string, number>();

  for (const candidate of ranked) {
    const key = diversityKey(candidate.record);
    const currentCount = diversityCounts.get(key) ?? 0;

    // Diversity gate
    if (currentCount >= diversityConstraint) {
      // Still consider for compression if score is high enough
      if (candidate.score >= COMPRESSION_FLOOR) {
        const item = compressRecord(candidate.record, candidate.score, modelId);
        if (usedTokens + item.tokenCost <= availableBudget) {
          compressed.push(item);
          usedTokens += item.tokenCost;
        } else {
          evicted.push(candidate.record);
        }
      } else {
        evicted.push(candidate.record);
      }
      continue;
    }

    // Budget check for full inclusion
    if (usedTokens + candidate.cost <= availableBudget) {
      included.push(candidate.record);
      usedTokens += candidate.cost;
      diversityCounts.set(key, currentCount + 1);
    } else if (candidate.score >= COMPRESSION_FLOOR) {
      // Doesn't fit at full size — try compression
      const item = compressRecord(candidate.record, candidate.score, modelId);
      if (usedTokens + item.tokenCost <= availableBudget) {
        compressed.push(item);
        usedTokens += item.tokenCost;
      } else {
        evicted.push(candidate.record);
      }
    } else {
      evicted.push(candidate.record);
    }
  }

  const totalUsed =
    systemTokens + proceduralTokens + usedTokens + workingTokens;

  return {
    included,
    compressed,
    evicted,
    tokenUsage: {
      system: systemTokens,
      procedural: proceduralTokens,
      volatile: usedTokens,
      working: workingTokens,
      total: totalUsed,
      budgetRemaining: budget.total - totalUsed,
    },
    pinnedTruncated,
  };
}
