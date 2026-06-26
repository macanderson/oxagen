/**
 * Knapsack packer — budget-constrained context packing that maximizes
 * task-value per token.
 *
 * Greedy algorithm with diversity constraints. Guarantees:
 * - Budget is NEVER exceeded
 * - Pinned procedural rules are ALWAYS included
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
 * Pack candidates into a budget-constrained context window.
 */
export function pack(input: PackerInput): PackResult {
  const { candidates, budget, pinnedRecords, diversityConstraint, modelId } = input;

  const included: MemoryRecord[] = [];
  const compressed: CompressedItem[] = [];
  const evicted: MemoryRecord[] = [];

  // Step 1: Account for pinned procedural rules (always included)
  let proceduralTokens = 0;
  for (const record of pinnedRecords) {
    const text = JSON.stringify(record.body);
    proceduralTokens += countTokens(text, modelId);
    included.push(record);
  }

  // Step 2: Available budget for retrieved volatile content
  const availableBudget = budget.reserved.volatile;
  let usedTokens = 0;

  // Step 3: Sort candidates by value-per-token (greedy knapsack)
  const ranked = candidates
    .filter((c) => !pinnedRecords.some((p) => p.id === c.record.id)) // Skip already-included pinned
    .map((c) => ({
      ...c,
      vpt: c.tokenCost > 0 ? c.score / c.tokenCost : c.score,
    }))
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
        const item = compressRecord(candidate.record, candidate.score);
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
    if (usedTokens + candidate.tokenCost <= availableBudget) {
      included.push(candidate.record);
      usedTokens += candidate.tokenCost;
      diversityCounts.set(key, currentCount + 1);
    } else if (candidate.score >= COMPRESSION_FLOOR) {
      // Doesn't fit at full size — try compression
      const item = compressRecord(candidate.record, candidate.score);
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

  const totalUsed = budget.reserved.system + proceduralTokens + usedTokens + budget.reserved.working;

  return {
    included,
    compressed,
    evicted,
    tokenUsage: {
      system: budget.reserved.system,
      procedural: proceduralTokens,
      volatile: usedTokens,
      working: budget.reserved.working,
      total: totalUsed,
      budgetRemaining: budget.total - totalUsed,
    },
  };
}
