// triage-corrections.ts: the corrections a person made to a triage decision.
//
// A person can change the priority, a label, the estimate, the workflow, or a
// criterion before the item is sent (agent-work-spec.html, Corrections). Each
// change is one work.triage_corrections row, and each row is a preference pair
// a later triage model can learn from. So a list field yields one row per item
// that changed, not one row for the whole list: removing one label and adding
// another is two rows.
import type { TrainingCorrection, TriageDecision } from "../types";

/** The decision fields a person can correct. */
export type TriageCorrectable = Pick<
  TriageDecision,
  "state" | "priority" | "labels" | "estimate_minutes" | "workflow" | "duplicates" | "claims" | "done_record"
>;

/** The field names a correction row carries. */
export const TRIAGE_CORRECTION_FIELDS = [
  "state",
  "priority",
  "label",
  "estimate_minutes",
  "workflow",
  "duplicate",
  "claim",
  "criterion",
] as const;
export type TriageCorrectionField = (typeof TRIAGE_CORRECTION_FIELDS)[number];

/** One row per value removed, then one row per value added, each in list order. */
function setDiff(field: TriageCorrectionField, before: readonly string[], after: readonly string[]): TrainingCorrection[] {
  const kept = new Set(after);
  const had = new Set(before);
  return [
    ...before.filter((value) => !kept.has(value)).map((value) => ({ field, before: value, after: null })),
    ...after.filter((value) => !had.has(value)).map((value) => ({ field, before: null, after: value })),
  ];
}

/** Takes one of each value in `drop` out of `from`, and returns the rest in order. */
function without(from: readonly string[], drop: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of drop) counts.set(value, (counts.get(value) ?? 0) + 1);
  const rest: string[] = [];
  for (const value of from) {
    const count = counts.get(value) ?? 0;
    if (count > 0) counts.set(value, count - 1);
    else rest.push(value);
  }
  return rest;
}

/**
 * Criteria may repeat, so they compare as a multiset. A removed criterion and an
 * added one pair up in order as one edit. The rest are plain removals or
 * additions.
 */
function criteriaDiff(before: readonly string[], after: readonly string[]): TrainingCorrection[] {
  const removed = without(before, after);
  const added = without(after, before);
  const rows: TrainingCorrection[] = [];
  const paired = Math.max(removed.length, added.length);
  for (let index = 0; index < paired; index += 1) {
    rows.push({ field: "criterion", before: removed[index] ?? null, after: added[index] ?? null });
  }
  return rows;
}

/** One correction per changed field, or per changed item of a list field. */
export function triageCorrections(before: TriageCorrectable, after: TriageCorrectable): TrainingCorrection[] {
  const rows: TrainingCorrection[] = [];
  if (before.state !== after.state) rows.push({ field: "state", before: before.state, after: after.state });
  if (before.priority.label !== after.priority.label) {
    rows.push({ field: "priority", before: before.priority.label, after: after.priority.label });
  }
  rows.push(...setDiff("label", before.labels, after.labels));
  if (before.estimate_minutes !== after.estimate_minutes) {
    rows.push({ field: "estimate_minutes", before: before.estimate_minutes, after: after.estimate_minutes });
  }
  if (before.workflow !== after.workflow) rows.push({ field: "workflow", before: before.workflow, after: after.workflow });
  rows.push(...setDiff("duplicate", before.duplicates, after.duplicates));
  rows.push(...setDiff("claim", before.claims, after.claims));
  rows.push(...criteriaDiff(before.done_record?.criteria ?? [], after.done_record?.criteria ?? []));
  return rows;
}
