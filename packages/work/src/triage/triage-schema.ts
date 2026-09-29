// triage-schema.ts: the triage/v1 schema the model request carries, and the
// check every model output passes before triage keeps it.
//
// The schema file is imported rather than read from disk, so a bundle that
// inlines this package still carries it. checkTriageSchema repeats the file's
// rules by hand, because this package ships no JSON Schema validator at
// runtime. triage-schema.test.ts runs Ajv and this check over the same
// documents and fails when they disagree.
import triageV1 from "../../schemas/triage.v1.json";
import { PRIORITY_LABELS, TRIAGE_SCHEMA, TRIAGE_STATES, type TriageDecision } from "../types";

/** The triage/v1 JSON Schema, as schemas/triage.v1.json holds it. */
export const TRIAGE_V1_SCHEMA: Record<string, unknown> = triageV1;

const CITE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]#[0-9]+$/;
const WORK_ITEM_ID = /^wi_[0-9A-Za-z]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;

const DECISION_KEYS = [
  "schema",
  "item",
  "state",
  "priority",
  "labels",
  "estimate_minutes",
  "claims",
  "duplicates",
  "related",
  "workflow",
  "done_record",
  "questions",
  "conflicts",
] as const;
const PRIORITY_KEYS = ["label", "reason", "cites"] as const;

/** A checked output, or the rules it broke, each as a JSON pointer and a reason. */
export type TriageCheck = { ok: true; decision: TriageDecision } | { ok: false; problems: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= SLUG_MAX_LENGTH && SLUG.test(value);
}

/** Checks the keys of an object with additionalProperties false and every key required. */
function checkKeys(value: Json, keys: readonly string[], path: string, problems: string[]): void {
  for (const key of keys) {
    if (!(key in value)) problems.push(`${path}/${key} is missing`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) problems.push(`${path}/${key} is not a triage/v1 field`);
  }
}

/** Checks an array of strings. Returns the array when every item passed. */
function checkStrings(
  value: unknown,
  path: string,
  problems: string[],
  rules: { unique?: boolean; pattern?: RegExp; minItems?: number },
): string[] | null {
  if (!Array.isArray(value)) {
    problems.push(`${path} is not an array`);
    return null;
  }
  const before = problems.length;
  value.forEach((item: unknown, index) => {
    if (typeof item !== "string") problems.push(`${path}/${index} is not a string`);
    else if (rules.pattern ? !rules.pattern.test(item) : item.length === 0) {
      problems.push(rules.pattern ? `${path}/${index} does not match ${rules.pattern.source}` : `${path}/${index} is empty`);
    }
  });
  if (rules.unique && new Set(value).size !== value.length) problems.push(`${path} repeats an item`);
  if (rules.minItems !== undefined && value.length < rules.minItems) {
    problems.push(`${path} needs at least ${rules.minItems} item`);
  }
  return problems.length === before ? (value as string[]) : null;
}

function checkPriority(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("/priority is not an object");
    return;
  }
  checkKeys(value, PRIORITY_KEYS, "/priority", problems);
  if ("label" in value && !(PRIORITY_LABELS as readonly unknown[]).includes(value.label)) {
    problems.push("/priority/label is not P0, P1, P2, or P3");
  }
  if ("reason" in value && (typeof value.reason !== "string" || value.reason.length === 0)) {
    problems.push("/priority/reason is not a non-empty string");
  }
  if ("cites" in value) checkStrings(value.cites, "/priority/cites", problems, { unique: true, pattern: CITE });
}

function checkDoneRecord(value: unknown, problems: string[]): void {
  if (value === null) return;
  if (!isObject(value)) {
    problems.push("/done_record is not an object or null");
    return;
  }
  checkKeys(value, ["criteria"], "/done_record", problems);
  if ("criteria" in value) checkStrings(value.criteria, "/done_record/criteria", problems, { minItems: 1 });
}

/** The allOf rules: what each state requires of the other fields. */
function checkState(value: Json, problems: string[]): void {
  switch (value.state) {
    case "triaged":
      if ("workflow" in value && !isSlug(value.workflow)) problems.push("/workflow is required when the state is triaged");
      if ("done_record" in value && !isObject(value.done_record)) {
        problems.push("/done_record is required when the state is triaged");
      }
      break;
    case "needs_info":
      if (Array.isArray(value.questions) && value.questions.length === 0) {
        problems.push("/questions needs at least 1 item when the state is needs_info");
      }
      break;
    case "duplicate":
      if (Array.isArray(value.duplicates) && value.duplicates.length === 0) {
        problems.push("/duplicates needs at least 1 item when the state is duplicate");
      }
      break;
    case "out_of_scope":
      if ("done_record" in value && value.done_record !== null) {
        problems.push("/done_record must be null when the state is out_of_scope");
      }
      break;
    default:
      break;
  }
}

/** Checks a value against triage/v1. */
export function checkTriageSchema(value: unknown): TriageCheck {
  const problems: string[] = [];
  if (!isObject(value)) return { ok: false, problems: ["/ is not an object"] };
  checkKeys(value, DECISION_KEYS, "", problems);
  if ("schema" in value && value.schema !== TRIAGE_SCHEMA) problems.push(`/schema is not ${TRIAGE_SCHEMA}`);
  if ("item" in value && (typeof value.item !== "string" || !WORK_ITEM_ID.test(value.item))) {
    problems.push("/item is not a work item id");
  }
  if ("state" in value && !(TRIAGE_STATES as readonly unknown[]).includes(value.state)) {
    problems.push("/state is not a triage state");
  }
  if ("priority" in value) checkPriority(value.priority, problems);
  if ("labels" in value) checkStrings(value.labels, "/labels", problems, { unique: true });
  if ("estimate_minutes" in value) {
    const minutes = value.estimate_minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0) {
      problems.push("/estimate_minutes is not a whole number of minutes");
    }
  }
  if ("claims" in value) checkStrings(value.claims, "/claims", problems, { unique: true });
  if ("duplicates" in value) checkStrings(value.duplicates, "/duplicates", problems, { unique: true, pattern: WORK_ITEM_ID });
  if ("related" in value) checkStrings(value.related, "/related", problems, { unique: true, pattern: WORK_ITEM_ID });
  if ("workflow" in value && value.workflow !== null && !isSlug(value.workflow)) {
    problems.push("/workflow is not a workflow slug or null");
  }
  if ("done_record" in value) checkDoneRecord(value.done_record, problems);
  if ("questions" in value) checkStrings(value.questions, "/questions", problems, {});
  if ("conflicts" in value) checkStrings(value.conflicts, "/conflicts", problems, {});
  checkState(value, problems);
  return problems.length === 0 ? { ok: true, decision: value as unknown as TriageDecision } : { ok: false, problems };
}
