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

/** A contiguous run of tool calls within a single turn. */
export interface ToolSequence {
  /** Tool names in call order. */
  tools: string[];
  /** Record IDs of the tool_call events, aligned 1:1 with `tools`. */
  eventIds: string[];
  /** Occurrence times (record.createdAt) aligned 1:1 with `tools`. */
  timestamps: number[];
  /** Turn outcome. */
  outcome: "success" | "failure" | "unknown";
}

/** The turn a tool_call belongs to, or null if unknown. */
function turnOf(body: Record<string, unknown>): string | null {
  const payload = body.payload as Record<string, unknown> | undefined;
  const t = payload?.turnId ?? body.turnId;
  return typeof t === "string" ? t : null;
}

/**
 * Extract tool-call sequences from a session's episodic events.
 *
 * A sequence is a contiguous run of tool_call events within ONE turn — it must
 * not span turns, or a pattern like `[deploy]→[read_file]` could be fabricated
 * from the end of one turn and the start of the next. Turn boundaries are the
 * explicit `turn_start`/`turn_end` marker events and a change in `payload.turnId`.
 */
export function extractToolSequences(events: MemoryRecord[]): ToolSequence[] {
  const sequences: ToolSequence[] = [];
  let tools: string[] = [];
  let eventIds: string[] = [];
  let timestamps: number[] = [];
  let currentTurn: string | null = null;

  const flush = (outcome: "success" | "failure" | "unknown") => {
    if (tools.length > 0) {
      sequences.push({ tools, eventIds, timestamps, outcome });
    }
    tools = [];
    eventIds = [];
    timestamps = [];
  };

  for (const event of events) {
    const body = event.body as Record<string, unknown>;
    const eventType = body.event;

    // Explicit turn boundaries flush the in-progress sequence.
    if (eventType === "turn_start" || eventType === "turn_end") {
      const outcome =
        (body.outcome as "success" | "failure" | "unknown") ?? "unknown";
      flush(outcome);
      currentTurn = eventType === "turn_start" ? turnOf(body) : null;
      continue;
    }

    if (eventType === "tool_call") {
      const turn = turnOf(body);
      // A change in turnId ends the previous turn's sequence.
      if (
        tools.length > 0 &&
        turn !== null &&
        currentTurn !== null &&
        turn !== currentTurn
      ) {
        flush("unknown");
      }
      if (turn !== null) currentTurn = turn;
      const payload = body.payload as Record<string, unknown> | undefined;
      const toolName =
        (payload?.tool as string) ?? (payload?.name as string) ?? "unknown";
      tools.push(toolName);
      eventIds.push(event.id);
      timestamps.push(Number(event.createdAt));
    } else if (tools.length > 0) {
      // A non-tool event within the turn ends the run and carries its outcome.
      const outcome =
        (body.outcome as "success" | "failure" | "unknown") ?? "unknown";
      flush(outcome);
    }
  }

  flush("unknown");
  return sequences;
}

/**
 * Detect recurring action patterns across multiple sessions.
 *
 * Counting caveat: every POSITION at which an n-gram occurs increments its
 * counter, so one turn that loops `[a, b, a, b, a, b]` registers `a → b` three
 * times. A single repetitive turn can therefore clear `minOccurrences` on its
 * own, and `promotePatterns` may mint a procedural rule from what was really
 * one observation. Counting distinct sequences rather than positions would fix
 * this, at the cost of re-baselining every existing threshold.
 */
export function detectPatterns(
  sessionEvents: MemoryRecord[][],
  config: PatternConfig = DEFAULT_PATTERN_CONFIG,
): ActionPattern[] {
  // Extract all tool sequences from all sessions
  const allSequences = sessionEvents.flatMap(extractToolSequences);

  // Count n-gram occurrences
  const ngramCounts = new Map<
    string,
    { success: number; failure: number; examples: string[]; lastSeen: number }
  >();

  for (const seq of allSequences) {
    // Generate all n-grams of valid length
    for (
      let len = config.minLength;
      len <= Math.min(config.maxLength, seq.tools.length);
      len++
    ) {
      for (let start = 0; start <= seq.tools.length - len; start++) {
        const ngram = seq.tools.slice(start, start + len);
        const key = ngram.join(" → ");
        const existing = ngramCounts.get(key) ?? {
          success: 0,
          failure: 0,
          examples: [],
          lastSeen: 0,
        };

        if (seq.outcome === "success") existing.success++;
        else if (seq.outcome === "failure") existing.failure++;

        // lastSeen is the newest OCCURRENCE time of the pattern (from the event
        // record), not wall-clock Date.now() — otherwise every pattern looks
        // like it was just seen and recency-based decisions are meaningless.
        const occurredAt = Math.max(
          ...seq.timestamps.slice(start, start + len),
        );
        if (occurredAt > existing.lastSeen) existing.lastSeen = occurredAt;

        // Examples are the concrete event IDs that formed this occurrence, so a
        // promoted rule can cite the evidence — not the n-gram string itself.
        if (existing.examples.length < 10) {
          existing.examples.push(...seq.eventIds.slice(start, start + len));
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
  patterns.sort(
    (a, b) => b.successRate * b.successCount - a.successRate * a.successCount,
  );
  return patterns;
}
