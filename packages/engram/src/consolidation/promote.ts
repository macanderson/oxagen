/**
 * Procedural promotion — promotes successful action patterns into
 * procedural memory rules that persist across sessions.
 */
import type { MemoryRecord, ProceduralBody } from "../types";
import type { ActionPattern } from "./patterns";

export interface PromotionConfig {
  /** Minimum success rate for promotion. Default: 0.8. */
  minSuccessRate: number;
  /** Minimum total occurrences for promotion. Default: 5. */
  minPromotionCount: number;
}

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  minSuccessRate: 0.8,
  minPromotionCount: 5,
};

export interface PromotionCandidate {
  pattern: ActionPattern;
  proposedRule: ProceduralBody;
  confidence: number;
  reason: string;
}

/**
 * Evaluate patterns for promotion to procedural memory.
 *
 * A pattern is promoted when:
 * - Success rate > 80%
 * - Occurred > 5 times
 * - Not already captured by an existing procedural rule
 */
export function promotePatterns(
  patterns: ActionPattern[],
  existingRules: MemoryRecord[],
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];

  for (const pattern of patterns) {
    // Check thresholds. minPromotionCount is documented as "minimum total
    // occurrences", so gate on total (success + failure), not successCount —
    // otherwise a pattern that succeeds 5× but also fails 20× would promote.
    const totalOccurrences = pattern.successCount + pattern.failureCount;
    if (pattern.successRate < config.minSuccessRate) continue;
    if (totalOccurrences < config.minPromotionCount) continue;

    // Check if already captured by an existing rule
    if (isPatternCaptured(pattern, existingRules)) continue;

    // Generate the procedural rule
    const rule = generateRule(pattern);
    candidates.push({
      pattern,
      proposedRule: rule,
      confidence: pattern.successRate,
      reason: `Pattern seen ${pattern.successCount} times with ${Math.round(pattern.successRate * 100)}% success rate`,
    });
  }

  return candidates;
}

/**
 * Check if a pattern is already captured by an existing procedural rule.
 */
function isPatternCaptured(
  pattern: ActionPattern,
  existingRules: MemoryRecord[],
): boolean {
  // Order-sensitive: a rule capturing A → B does NOT capture B → A. Match the
  // ordered sequence string the same way generateRule() renders it, so we don't
  // treat a differently-ordered pattern as already covered.
  const sequenceStr = pattern.sequence.join(" → ").toLowerCase();
  for (const rule of existingRules) {
    if (rule.kind !== "procedural") continue;
    const body = rule.body as Record<string, unknown>;
    const ruleText = ((body.rule as string) ?? "").toLowerCase();
    if (ruleText.includes(sequenceStr)) return true;
  }
  return false;
}

/**
 * Generate a procedural rule from a detected pattern.
 */
function generateRule(pattern: ActionPattern): ProceduralBody {
  const sequenceStr = pattern.sequence.join(" → ");
  return {
    rule: `When performing related tasks, use the sequence: ${sequenceStr}. This pattern has a ${Math.round(pattern.successRate * 100)}% success rate.`,
    appliesTo: pattern.sequence,
    examples: pattern.examples.slice(0, 5),
    successCount: pattern.successCount,
    failureCount: pattern.failureCount,
  };
}
