/**
 * F4 — Cache-forked best-of-N (trunk + tails).
 *
 * Pure module for snapshotting the trunk conversation at the diagnosis point
 * and planning per-hypothesis tail forks. Reuses trunk messages as initial
 * context for each tail; instruction diverges per hypothesis.
 *
 * Public API
 * ----------
 *  messageText(m)              → string (plain text extraction)
 *  findSnapshotBoundary(msgs)  → number (index after DIAGNOSIS_MARKER)
 *  snapshotTrunk(msgs)         → TrunkSnapshot
 *  buildTailInstruction(h)     → string (divergence instruction)
 *  planForks(snapshot, max)    → Array of { hypothesis, history, instruction }
 *
 * Constraints (from spec F4)
 * --------------------------
 *  - Zero I/O, no filesystem/git access inside the module.
 *  - No external deps beyond "ai" types import.
 *  - No `any` (TypeScript strict).
 *  - messageText never throws; returns "" on unknown shapes.
 *  - snapshotTrunk never throws; diagnosis extraction is best-effort.
 *  - Hypothesis fallback: if no verdicts exist, use diagnosis.rootCauseHypotheses.
 */

import type { ModelMessage } from "ai";
import type { Diagnosis, Hypothesis } from "../evaluate/diagnosis";
import { extractDiagnosis, DIAGNOSIS_MARKER } from "../evaluate/diagnosis";
import {
  parseHypothesisMarkers,
  pairWithProbes,
  survivors,
} from "../oracle/hypotheses";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Snapshot of the trunk conversation at the diagnosis point, ready for forking.
 *
 * Fields:
 * - messages: the conversation up to and including the diagnosis emission
 * - diagnosis: extracted Diagnosis, or null if unparseable
 * - hypotheses: surviving hypotheses (from verdicts) or fallback from diagnosis
 */
export interface TrunkSnapshot {
  readonly messages: ModelMessage[];
  readonly diagnosis: Diagnosis | null;
  readonly hypotheses: Hypothesis[];
}

// ── messageText ────────────────────────────────────────────────────────────────

/**
 * Extract best-effort plain text from a ModelMessage.
 *
 * Handles:
 * - String content: returned as-is
 * - Array content (parts): concatenates text fields from parts; ignores non-text
 * - Unknown shapes: returns ""
 *
 * Never throws.
 */
export function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") {
    return m.content;
  }

  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const part of m.content) {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        parts.push(part.text);
      }
    }
    return parts.join("");
  }

  return "";
}

// ── findSnapshotBoundary ───────────────────────────────────────────────────────

/**
 * Find the index (slice end) after the last message containing DIAGNOSIS_MARKER.
 *
 * Scans messages for the LAST occurrence of DIAGNOSIS_MARKER in any message's text.
 * Returns the index after that message (so slice(0, boundary) includes it).
 *
 * If no marker found, returns messages.length.
 *
 * Never throws.
 */
export function findSnapshotBoundary(messages: ModelMessage[]): number {
  let lastMarkerIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const text = messageText(messages[i]!);
    if (text.includes(DIAGNOSIS_MARKER)) {
      lastMarkerIndex = i;
    }
  }

  if (lastMarkerIndex === -1) {
    return messages.length;
  }

  return lastMarkerIndex + 1;
}

// ── snapshotTrunk ────────────────────────────────────────────────────────────

/**
 * Create a TrunkSnapshot from messages.
 *
 * Extracts:
 * - boundary: index after last DIAGNOSIS_MARKER
 * - messages: messages.slice(0, boundary)
 * - diagnosis: extractDiagnosis from joined message text
 * - hypotheses: parseHypothesisMarkers → pairWithProbes → survivors
 *   - When survivors exist, use only survivors (falsified excluded)
 *   - When no verdicts exist at all, fallback to (diagnosis?.rootCauseHypotheses ?? []).slice(0, 3)
 *   - When verdicts exist but all falsified, use empty array
 *
 * Never throws.
 */
export function snapshotTrunk(messages: ModelMessage[]): TrunkSnapshot {
  const boundary = findSnapshotBoundary(messages);
  const snapshotMessages = messages.slice(0, boundary);

  // Join message text for diagnosis extraction
  const joinedText = snapshotMessages.map(messageText).join("\n");

  // Extract diagnosis
  const diagnosis = extractDiagnosis(joinedText);

  // Extract hypotheses from verdicts
  const verdicts = parseHypothesisMarkers(joinedText);

  // Pair verdicts with probes (empty commands list for now; engine will fill)
  const pairedWithProbes = pairWithProbes(verdicts, []);

  // Filter to survivors
  const survivingHypotheses = survivors(pairedWithProbes);

  // Determine final hypotheses: survivors if any verdicts, else fallback to diagnosis
  let hypotheses: Hypothesis[] = survivingHypotheses;
  if (verdicts.length === 0 && diagnosis) {
    hypotheses = diagnosis.rootCauseHypotheses.slice(0, 3);
  }

  return {
    messages: snapshotMessages,
    diagnosis,
    hypotheses,
  };
}

// ── buildTailInstruction ───────────────────────────────────────────────────────

/**
 * Build a divergence instruction for a single hypothesis fork.
 *
 * Instructs the tail agent to:
 * 1. Commit to this single hypothesis
 * 2. Implement the MINIMAL patch for it only
 * 3. Re-run the failing repro to flip it
 * 4. Run the nearest touched tests
 * 5. Do not pursue other hypotheses or refactors
 *
 * Under 120 words.
 *
 * Never throws.
 */
export function buildTailInstruction(h: Hypothesis): string {
  const idLine = `Hypothesis: ${h.id}`;
  const statementLine = `Statement: ${h.statement}`;
  const evidenceLine = h.evidence ? `Evidence: ${h.evidence}` : "";

  const parts = [
    "Commit to this single hypothesis and implement the MINIMAL patch for it only.",
    `${idLine}. ${statementLine}.`,
  ];

  if (evidenceLine) {
    parts.push(evidenceLine);
  }

  parts.push(
    "Re-run the failing repro to flip it. Run the nearest touched tests.",
    "Do not pursue other hypotheses or refactors.",
  );

  return parts.filter((p) => p).join(" ");
}

// ── planForks ────────────────────────────────────────────────────────────────

/**
 * Plan fork tails from a TrunkSnapshot.
 *
 * For each hypothesis (capped at max(1, maxTails)):
 * - Creates an entry with the hypothesis, the trunk messages, and the divergence instruction
 *
 * Returns array of fork plans. Empty array if snapshot has zero hypotheses.
 *
 * Never throws.
 */
export interface ForkPlan {
  readonly hypothesis: Hypothesis;
  readonly history: ModelMessage[];
  readonly instruction: string;
}

export function planForks(
  snapshot: TrunkSnapshot,
  maxTails: number,
): ForkPlan[] {
  if (snapshot.hypotheses.length === 0) {
    return [];
  }

  const cap = Math.max(1, maxTails);
  const plans: ForkPlan[] = [];

  for (let i = 0; i < Math.min(snapshot.hypotheses.length, cap); i++) {
    const hypothesis = snapshot.hypotheses[i]!;
    plans.push({
      hypothesis,
      history: snapshot.messages,
      instruction: buildTailInstruction(hypothesis),
    });
  }

  return plans;
}
