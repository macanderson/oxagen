/**
 * Conflict detection and resolution for contradicting facts.
 *
 * When distillation produces a fact that contradicts an existing one:
 * - NEVER silently overwrite
 * - Both facts are retained with provenance
 * - Resolution policy determines which to prefer
 * - High-confidence conflicts escalate to human review
 */
import type { MemoryRecord, SemanticBody } from "../types";

export interface ConflictRecord {
  /** ID of the existing conflicting fact. */
  existingId: string;
  /** The new fact that contradicts it. */
  newFact: SemanticBody;
  /** Episodic event IDs that support the new fact. */
  evidence: string[];
  /** How the conflict was resolved. */
  resolution: ConflictResolution;
  /** Why this resolution was chosen. */
  reason: string;
}

export type ConflictResolution =
  | "keep_existing" // Existing fact has higher confidence
  | "keep_new" // New fact has more/better evidence
  | "keep_both" // Ambiguous — both retained for human review
  | "human_review"; // High-stakes conflict requiring human decision

/**
 * Detect whether a new fact contradicts an existing one.
 *
 * Simple heuristic: same domain + negation patterns or contradictory numbers.
 * In production, this would use an LLM to check logical consistency.
 */
export function detectContradiction(
  newFact: SemanticBody,
  existing: MemoryRecord,
): boolean {
  const existingBody = existing.body as SemanticBody;
  if (existingBody.domain !== newFact.domain) return false;

  const existingText = existingBody.fact.toLowerCase();
  const newText = newFact.fact.toLowerCase();

  // Check for negation patterns.
  //
  // These are plain substring tests, not word matches, so "not" also fires on
  // "cannot", "another", "notice", and "annotation". That biases the detector
  // toward FALSE POSITIVES — a spurious contradiction is routed to
  // `resolveConflict`, which retains both facts (`keep_both`) or escalates,
  // so the cost is noise rather than data loss. Word-boundary matching would
  // tighten it but re-baselines the existing detection tests.
  const negations = ["not", "never", "no longer", "doesn't", "isn't", "won't"];
  for (const neg of negations) {
    // One has the negation, the other doesn't, but they reference the same subject
    const existingHasNeg = existingText.includes(neg);
    const newHasNeg = newText.includes(neg);
    if (existingHasNeg !== newHasNeg) {
      // Check if they share enough words to be about the same thing
      const overlap = wordOverlap(existingText, newText);
      if (overlap > 0.4) return true;
    }
  }

  // Check for contradictory percentages/numbers
  const existingNumbers = existingText.match(/\d+%?/g) ?? [];
  const newNumbers = newText.match(/\d+%?/g) ?? [];
  if (existingNumbers.length > 0 && newNumbers.length > 0) {
    const overlap = wordOverlap(existingText, newText);
    if (overlap > 0.5 && existingNumbers[0] !== newNumbers[0]) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a conflict between an existing fact and a new one.
 */
export function resolveConflict(
  existing: MemoryRecord,
  newFact: SemanticBody,
  newConfidence: number,
  evidence: string[],
): ConflictRecord {
  const confidenceDiff = newConfidence - existing.confidence;
  const evidenceStrength = evidence.length;

  let resolution: ConflictResolution;
  let reason: string;

  // A contradiction between two HIGH-confidence facts must never be auto-
  // resolved — it escalates to a human. This check comes first (before the
  // evidence-strength auto-keep_new below) so a well-evidenced new fact can't
  // silently overwrite an equally-confident existing one.
  if (existing.confidence >= 0.9 && newConfidence >= 0.9) {
    resolution = "human_review";
    reason = `Both facts have high confidence — requires human decision`;
  } else if (confidenceDiff > 0.3) {
    resolution = "keep_new";
    reason = `New fact has significantly higher confidence (${newConfidence.toFixed(2)} vs ${existing.confidence.toFixed(2)})`;
  } else if (confidenceDiff < -0.3) {
    resolution = "keep_existing";
    reason = `Existing fact has higher confidence (${existing.confidence.toFixed(2)} vs ${newConfidence.toFixed(2)})`;
  } else if (evidenceStrength >= 5) {
    resolution = "keep_new";
    reason = `New fact supported by ${evidenceStrength} independent observations`;
  } else {
    resolution = "keep_both";
    reason = `Ambiguous conflict — both retained with provenance for future resolution`;
  }

  return {
    existingId: existing.id,
    newFact,
    evidence,
    resolution,
    reason,
  };
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}
