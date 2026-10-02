// triage-corrections.ts: a person's corrections to a triage suggestion, and
// the suggestion as a person sees it once the corrections apply.
//
// agent-work-phase-1.html (Work lifecycle) says triage may update its
// suggestions, and a person's edits stay in force until the person clears
// them. So a correction is stored against the field, not the decision: when
// the source changes and triage writes a new decision, effectiveTriage still
// applies every correction the item holds. A cleared field goes back to what
// triage suggests.
//
// Each correction is one work.triage_corrections row: the field, the value
// before, the value after, who, and when. `after` is the person's value, or
// null when the person cleared their correction. No correctable field takes
// null as a value, so null always means cleared.
//
// The outcome (triaged, needs_info, duplicate, out of scope) is not a field
// here. A person changes it with a triage_overridden fact, which the item's
// reducer reads (@oxagen/work/records reduce.ts).
import { PRIORITY_LABELS, type PriorityLabel, type TriageDecision } from "../types";

/** The suggestion fields a person can correct. */
export const TRIAGE_CORRECTION_FIELDS = ["priority", "estimate_minutes", "labels", "claims", "criteria"] as const;
export type TriageCorrectionField = (typeof TRIAGE_CORRECTION_FIELDS)[number];

/** The value each field holds. */
export interface TriageFieldValues {
  priority: PriorityLabel;
  estimate_minutes: number;
  labels: string[];
  /** Path globs the work is predicted to change. */
  claims: string[];
  /** The acceptance criteria triage drafted. */
  criteria: string[];
}

/** The most entries a list field takes, and the longest entry. */
export const TRIAGE_LIST_MAX_ITEMS = 50;
export const TRIAGE_TEXT_MAX_CHARS = 1000;
/** The largest estimate a person can enter: 30 days of agent minutes. */
export const TRIAGE_ESTIMATE_MAX_MINUTES = 43_200;

/** One stored correction. `after` is null when the person cleared the field. */
export interface TriageCorrection<F extends TriageCorrectionField = TriageCorrectionField> {
  field: F;
  before: TriageFieldValues[F] | null;
  after: TriageFieldValues[F] | null;
  /** The user id of the person. */
  by: string;
  /** When, as an ISO 8601 time. */
  at: string;
}

/** One field as a person sees it: the value, and whether triage or a person set it. */
export interface TriageField<T> {
  value: T | null;
  /** `oxagen` for a suggestion, `person` for a correction, null when neither set it. */
  by: "oxagen" | "person" | null;
  /** The person who corrected it. */
  actor: string | null;
  at: string | null;
}

/** A triage suggestion with every correction in force applied. */
export interface TriageView {
  /** The triage decision's public id, or null when triage has not decided. */
  decision: string | null;
  priority: TriageField<PriorityLabel>;
  /** Triage's reason for its priority. Null when a person set the priority. */
  priorityReason: string | null;
  /** The priorities rules triage cited. Empty when a person set the priority. */
  cites: string[];
  estimate_minutes: TriageField<number>;
  labels: TriageField<string[]>;
  claims: TriageField<string[]>;
  criteria: TriageField<string[]>;
  questions: string[];
  duplicates: string[];
  related: string[];
  conflicts: string[];
}

function suggested<T>(value: T | null): TriageField<T> {
  return { value, by: value === null ? null : "oxagen", actor: null, at: null };
}

/** The value a decision suggests for a field. */
function suggestion(decision: TriageDecision | null): { [F in TriageCorrectionField]: TriageFieldValues[F] | null } {
  if (decision === null) {
    return { priority: null, estimate_minutes: null, labels: null, claims: null, criteria: null };
  }
  return {
    priority: decision.priority.label,
    estimate_minutes: decision.estimate_minutes,
    labels: [...decision.labels],
    claims: [...decision.claims],
    criteria: decision.done_record === null ? null : [...decision.done_record.criteria],
  };
}

/** The latest correction of each field, by time, then by order given. A cleared one drops the field. */
function inForce(corrections: readonly TriageCorrection[]): Map<TriageCorrectionField, TriageCorrection> {
  const sorted = corrections
    .map((correction, index) => ({ correction, index }))
    .sort((a, b) => Date.parse(a.correction.at) - Date.parse(b.correction.at) || a.index - b.index);
  const latest = new Map<TriageCorrectionField, TriageCorrection>();
  for (const { correction } of sorted) {
    if (correction.after === null) latest.delete(correction.field);
    else latest.set(correction.field, correction);
  }
  return latest;
}

/**
 * The suggestion a person sees: the latest decision, with every correction in
 * force applied. Corrections from earlier decisions still apply, so a new
 * triage run never undoes a person's edit. Pure.
 */
export function effectiveTriage(
  decision: TriageDecision | null,
  decisionId: string | null,
  corrections: readonly TriageCorrection[],
): TriageView {
  const values = suggestion(decision);
  const corrected = inForce(corrections);
  const field = <F extends TriageCorrectionField>(name: F): TriageField<TriageFieldValues[F]> => {
    const correction = corrected.get(name) as TriageCorrection<F> | undefined;
    if (correction === undefined) return suggested(values[name]);
    return { value: correction.after, by: "person", actor: correction.by, at: correction.at };
  };
  const priority = field("priority");
  const personPriority = priority.by === "person";
  return {
    decision: decision === null ? null : decisionId,
    priority,
    priorityReason: personPriority || decision === null ? null : decision.priority.reason,
    cites: personPriority || decision === null ? [] : [...decision.priority.cites],
    estimate_minutes: field("estimate_minutes"),
    labels: field("labels"),
    claims: field("claims"),
    criteria: field("criteria"),
    questions: decision === null ? [] : [...decision.questions],
    duplicates: decision === null ? [] : [...decision.duplicates],
    related: decision === null ? [] : [...decision.related],
    conflicts: decision === null ? [] : [...decision.conflicts],
  };
}

/** Why a correction was refused. */
export class TriageCorrectionError extends Error {
  readonly code = "triage_correction_invalid";
  constructor(message: string) {
    super(message);
    this.name = "TriageCorrectionError";
  }
}

function checkList(field: TriageCorrectionField, value: unknown): string[] {
  if (!Array.isArray(value)) throw new TriageCorrectionError(`${field} must be a list of text.`);
  if (value.length > TRIAGE_LIST_MAX_ITEMS) {
    throw new TriageCorrectionError(`${field} holds ${value.length} entries. The most is ${TRIAGE_LIST_MAX_ITEMS}.`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TriageCorrectionError(`Each entry in ${field} must be non-empty text.`);
    }
    if (entry.length > TRIAGE_TEXT_MAX_CHARS) {
      throw new TriageCorrectionError(`An entry in ${field} is longer than ${TRIAGE_TEXT_MAX_CHARS} characters.`);
    }
    const text = entry.trim();
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** Check one corrected value and return it in its stored form. Throws TriageCorrectionError. */
export function checkCorrectionValue<F extends TriageCorrectionField>(field: F, value: unknown): TriageFieldValues[F] {
  switch (field) {
    case "priority":
      if (!(PRIORITY_LABELS as readonly unknown[]).includes(value)) {
        throw new TriageCorrectionError(`The priority must be one of ${PRIORITY_LABELS.join(", ")}.`);
      }
      return value as TriageFieldValues[F];
    case "estimate_minutes":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > TRIAGE_ESTIMATE_MAX_MINUTES) {
        throw new TriageCorrectionError(`The estimate must be a whole number of minutes from 0 to ${TRIAGE_ESTIMATE_MAX_MINUTES}.`);
      }
      return value as TriageFieldValues[F];
    case "criteria": {
      const list = checkList(field, value);
      if (list.length === 0) throw new TriageCorrectionError("Keep at least one acceptance criterion, or clear the correction.");
      return list as TriageFieldValues[F];
    }
    default:
      return checkList(field, value) as TriageFieldValues[F];
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The correction rows a person's edit writes: one per field whose value it
 * changes, against the view the person read. A value equal to what the view
 * shows writes nothing. Null clears a person's correction, and clearing a
 * field no person corrected writes nothing. Pure, except that it refuses an
 * invalid value with TriageCorrectionError.
 */
export function correctionRows(
  view: TriageView,
  edits: Partial<{ [F in TriageCorrectionField]: TriageFieldValues[F] | null }>,
  by: string,
  at: string,
): TriageCorrection[] {
  const rows: TriageCorrection[] = [];
  for (const field of TRIAGE_CORRECTION_FIELDS) {
    if (!(field in edits)) continue;
    const raw = edits[field];
    const current = view[field] as TriageField<TriageFieldValues[typeof field]>;
    if (raw === null || raw === undefined) {
      if (current.by === "person") rows.push({ field, before: current.value, after: null, by, at } as TriageCorrection);
      continue;
    }
    const value = checkCorrectionValue(field, raw);
    if (same(value, current.value)) continue;
    rows.push({ field, before: current.value, after: value, by, at } as TriageCorrection);
  }
  return rows;
}

/** True when the value is a field name a person can correct. */
export function isTriageCorrectionField(value: unknown): value is TriageCorrectionField {
  return (TRIAGE_CORRECTION_FIELDS as readonly unknown[]).includes(value);
}
