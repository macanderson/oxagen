/**
 * Write-time salience heuristic.
 *
 * Salience (0.0–1.0) represents how important a memory is at the moment
 * it's written. Higher salience records surface more readily during
 * retrieval (Phase B) and resist eviction during consolidation (Phase D).
 *
 * This module provides heuristic scoring based on record kind and body
 * content. Callers can override with explicit salience values.
 */
import type {
  RecordKind,
  EpisodicBody,
  SemanticBody,
  ProceduralBody,
} from "./types";

/** Baseline salience by record kind. */
const KIND_BASELINES: Record<RecordKind, number> = {
  episodic: 0.3,
  semantic: 0.5,
  procedural: 0.7,
  entity: 0.4,
  edge: 0.3,
};

/** Outcome-based boost for episodic events. */
const OUTCOME_BOOST: Record<string, number> = {
  success: 0.1,
  failure: 0.2, // Failures are more informative
  unknown: 0.0,
};

/** High-salience event types that deserve a boost. */
const HIGH_SALIENCE_EVENTS = new Set([
  "error",
  "decision",
  "correction",
  "user_feedback",
  "milestone",
  "breakthrough",
]);

/**
 * Compute heuristic salience for a record based on its kind and body.
 * Returns a value in [0.0, 1.0].
 */
export function computeSalience(kind: RecordKind, body: unknown): number {
  let score = KIND_BASELINES[kind];

  switch (kind) {
    case "episodic":
      score = scoreEpisodic(score, body as Partial<EpisodicBody>);
      break;
    case "semantic":
      score = scoreSemantic(score, body as Partial<SemanticBody>);
      break;
    case "procedural":
      score = scoreProcedural(score, body as Partial<ProceduralBody>);
      break;
    // entity and edge use baseline only
  }

  return clamp(score, 0, 1);
}

function scoreEpisodic(base: number, body: Partial<EpisodicBody>): number {
  let score = base;

  // Boost for outcome
  if (body.outcome) {
    score += OUTCOME_BOOST[body.outcome] ?? 0;
  }

  // Boost for high-salience event types
  if (body.event && HIGH_SALIENCE_EVENTS.has(body.event)) {
    score += 0.15;
  }

  return score;
}

function scoreSemantic(base: number, body: Partial<SemanticBody>): number {
  let score = base;

  // Facts that supersede others are corrections — more important
  if (body.supersedes && body.supersedes.length > 0) {
    score += 0.15;
  }

  return score;
}

function scoreProcedural(base: number, body: Partial<ProceduralBody>): number {
  let score = base;

  // Rules with high success ratio deserve a boost
  const total = (body.successCount ?? 0) + (body.failureCount ?? 0);
  if (total > 0) {
    const successRatio = (body.successCount ?? 0) / total;
    // Proven rules (> 80% success, enough samples) get max boost
    if (successRatio > 0.8 && total >= 3) {
      score += 0.2;
    } else if (successRatio > 0.5) {
      score += 0.1;
    }
  }

  return score;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
