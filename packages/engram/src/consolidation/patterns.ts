/**
 * Pattern detection — finds recurring successful action sequences in
 * episodic event histories. Patterns that pass threshold checks become
 * candidates for procedural promotion.
 */
import type { MemoryRecord } from "../types";

export interface ActionPattern {
  /** Ordered tool/action names forming the pattern. */
  sequence: string[];
  /** Times this sequence led to success. */
  successCount: number;
  /** Times this sequence led to failure. */
  failureCount: number;
  /** successCount / total. */
  successRate: number;
  /** Unix ms when last seen. */
  lastSeen: number;
  /** Episodic event IDs showing this pattern. */
  examples: string[];
}

export interface PatternConfig {
  /** Minimum sequence length to consider. Default: 2. */
  minLength: number;
  /** Maximum sequence length to consider. Default: 5. */
  maxLength: number;
  /** Minimum success rate for promotion consideration. Default: 0.7. */
  minSuccessRate: number;
  /** Minimum occurrence count. Default: 3. */
  minOccurrences: number;
}

export const DEFAULT_PATTERN_CONFIG: PatternConfig = {
  minLength: 2,
  maxLength: 5,
  minSuccessRate: 0.7,
  minOccurrences: 3,
};

/**
 * Extract tool call sequences from a session's episodic events.
 * A sequence is a contiguous series of tool_call events within one turn.
 */
export function extractToolSequences(
  events: MemoryRecord[],
): Array<{ tools: string[]; outcome: "success" | "failure" | "unknown" }> {
  const sequences: Array<{ tools: string[]; outcome: "success" | "failure" | "unknown" }> = [];
  let current: string[] = [];

  for (const event of events) {
    const body = event.body as Record<string, unknown>;
    if (body.event === "tool_call") {
      const payload = body.payload as Record<string, unknown> | undefined;
      const toolName = (payload?.tool as string) ?? (payload?.name as string) ?? "unknown";
      current.push(toolName);
    } else if (current.length > 0) {
      // End of tool sequence — determine outcome from the next event
      const outcome = (body.outcome as "success" | "failure" | "unknown") ?? "unknown";
      sequences.push({ tools: [...current], outcome });
      current = [];
    }
  }

  // Flush trailing sequence
  if (current.length > 0) {
    sequences.push({ tools: current, outcome: "unknown" });
  }

  return sequences;
}

/**
 * Detect recurring action patterns across multiple sessions.
 */
export function detectPatterns(
  sessionEvents: MemoryRecord[][],
  config: PatternConfig = DEFAULT_PATTERN_CONFIG,
): ActionPattern[] {
  // Extract all tool sequences from all sessions
  const allSequences = sessionEvents.flatMap(extractToolSequences);

  // Count n-gram occurrences
  const ngramCounts = new Map<string, { success: number; failure: number; examples: string[]; lastSeen: number }>();

  for (const seq of allSequences) {
    // Generate all n-grams of valid length
    for (let len = config.minLength; len <= Math.min(config.maxLength, seq.tools.length); len++) {
      for (let start = 0; start <= seq.tools.length - len; start++) {
        const ngram = seq.tools.slice(start, start + len);
        const key = ngram.join(" → ");
        const existing = ngramCounts.get(key) ?? { success: 0, failure: 0, examples: [], lastSeen: 0 };

        if (seq.outcome === "success") existing.success++;
        else if (seq.outcome === "failure") existing.failure++;

        existing.lastSeen = Date.now();
        if (existing.examples.length < 10) {
          existing.examples.push(key); // Placeholder — in production, store event IDs
        }
        ngramCounts.set(key, existing);
      }
    }
  }

  // Filter by thresholds and build ActionPattern objects
  const patterns: ActionPattern[] = [];
  for (const [key, counts] of ngramCounts) {
    const total = counts.success + counts.failure;
    if (total < config.minOccurrences) continue;

    const successRate = total > 0 ? counts.success / total : 0;
    if (successRate < config.minSuccessRate) continue;

    patterns.push({
      sequence: key.split(" → "),
      successCount: counts.success,
      failureCount: counts.failure,
      successRate,
      lastSeen: counts.lastSeen,
      examples: counts.examples,
    });
  }

  // Sort by value: success rate × occurrence count
  patterns.sort((a, b) => (b.successRate * b.successCount) - (a.successRate * a.successCount));
  return patterns;
}
