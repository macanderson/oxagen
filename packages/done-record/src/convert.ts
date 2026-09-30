// convert.ts: turn a record written before done-record/v1 into a done record.
//
// agent-work-spec.html (Done record, From today's records) sets the rules:
//
// - A definition of done from tasks-spec.md §8 converts one item to one
//   criterion. A check item becomes a criterion with a check, and a review
//   item becomes a criterion with a human check.
// - A witness record's oracles attach to the criteria they test. What the
//   witness called judgment-gated becomes a human check.
// - The lock digest changes, so every converted record comes back unlocked,
//   for a person to lock again.
//
// A run dod from dod-spec.md converts too: each of its checks becomes one
// criterion with the same check, since the six check kinds are unchanged.
import { DoneRecordError } from "./errors";
import { needsNegative } from "./lint";
import {
  CRITERION_ID_PATTERN,
  LINEAGE_MAX_LENGTH,
  LINEAGE_PATTERN,
  TRIAGE_ID_PATTERN,
  WORK_ITEM_ID_PATTERN,
  checkKind,
  isActor,
} from "./patterns";
import {
  BUDGET_DEFAULT_STOP_ATTEMPTS,
  CRITERION_TAGS,
  DONE_RECORD_SCHEMA,
  MAX_CRITERIA,
  ORACLE_CLASSES,
  type BudgetCheck,
  type Check,
  type CheckKind,
  type Criterion,
  type CriterionTag,
  type DiffCheck,
  type DoneRecord,
  type DraftedBy,
  type FileCheck,
  type OracleClass,
  type TriageDecisionId,
  type WorkItemId,
} from "./types";

/** One check in a run dod. The kinds and shapes are the ones done-record/v1 keeps. */
export type RunDodCheck = { id: string } & Check;

/** A run dod from dod-spec.md: `.oxagen/dod/<run>.yaml`. */
export interface RunDod {
  dod: 1;
  task: string;
  run: string;
  locked?: string;
  checks: RunDodCheck[];
}

/** Where a converted record belongs. */
export interface ConvertTarget {
  item: WorkItemId;
  lineage: string;
  /**
   * The handle of the person who signs each human check. A run dod's human
   * check names what to review, not who reviews it, so a record with one
   * needs a reviewer.
   */
  reviewer?: string;
}

/** The stage that owns each check kind in a converted run dod. */
const RUN_DOD_TAGS: Record<CheckKind, CriterionTag> = {
  run: "test",
  file: "code",
  diff: "code",
  tools: "code",
  budget: "code",
  human: "review",
};

/** Quote a value as a code span, or as a JSON string when it holds a backtick. */
function code(value: string): string {
  return value.includes("`") ? JSON.stringify(value) : `\`${value}\``;
}

/** Join words with commas and "or", using the Oxford comma. */
function anyOf(values: readonly string[]): string {
  if (values.length <= 2) return values.join(" or ");
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

/** Join words with commas and "and", using the Oxford comma. */
function allOf(values: readonly string[]): string {
  if (values.length <= 2) return values.join(" and ");
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function fileText(check: FileCheck): string {
  const { path, exists, contains, sha256 } = check.file;
  if (exists === false) return `${code(path)} does not exist.`;
  const parts: string[] = [];
  if (contains !== undefined) parts.push(`contains ${code(contains)}`);
  if (sha256 !== undefined) parts.push(`matches ${code(sha256)}`);
  return parts.length === 0 ? `${code(path)} exists.` : `${code(path)} ${allOf(parts)}.`;
}

function diffText(check: DiffCheck): { text: string; negative?: string } {
  const allow = check.diff.allow ?? ["**"];
  const deny = check.diff.deny ?? [];
  const everywhere = allow.length === 1 && allow[0] === "**";
  const denied = deny.map(code);
  const firstDenied = denied[0];
  const negative =
    firstDenied !== undefined
      ? `A change to files that match ${firstDenied} fails.`
      : "A change outside those paths fails.";
  if (everywhere) {
    if (firstDenied === undefined) return { text: "The change may touch any file." };
    return { text: `The change touches nothing that matches ${anyOf(denied)}.`, negative };
  }
  const only = `The change touches only files that match ${anyOf(allow.map(code))}.`;
  const text = firstDenied === undefined ? only : `${only} It touches nothing that matches ${anyOf(denied)}.`;
  return { text, negative };
}

function budgetText(check: BudgetCheck): string {
  const { usd, tool_calls, minutes, stop_attempts } = check.budget;
  const limits: string[] = [];
  if (usd !== undefined) limits.push(`$${usd.toFixed(2)}`);
  if (tool_calls !== undefined) limits.push(plural(tool_calls, "tool call", "tool calls"));
  if (minutes !== undefined) limits.push(plural(minutes, "minute", "minutes"));
  const attempts = stop_attempts ?? BUDGET_DEFAULT_STOP_ATTEMPTS;
  const tries = `The agent tries to finish at most ${plural(attempts, "time", "times")}.`;
  return limits.length === 0 ? tries : `The work spends at most ${allOf(limits)}. ${tries}`;
}

function requireReviewer(reviewer: string | undefined, what: string): string {
  if (reviewer === undefined) {
    throw new DoneRecordError(
      "invalid_input",
      `${what} has a human check, so the conversion needs a reviewer. Pass the handle of the person who signs.`,
    );
  }
  if (!isActor(reviewer)) {
    throw new DoneRecordError(
      "invalid_input",
      `The reviewer "${reviewer}" is not a workspace handle. Use lowercase letters, digits, dots, underscores, and hyphens.`,
    );
  }
  return reviewer;
}

function requireTarget(target: ConvertTarget): void {
  if (!WORK_ITEM_ID_PATTERN.test(target.item)) {
    throw new DoneRecordError(
      "invalid_input",
      `The work item id "${target.item}" is not wi_ followed by letters and digits.`,
    );
  }
  if (target.lineage.length > LINEAGE_MAX_LENGTH || !LINEAGE_PATTERN.test(target.lineage)) {
    throw new DoneRecordError(
      "invalid_input",
      `The lineage "${target.lineage}" is not a dotted lineage such as aintel.core.bug-fixer.`,
    );
  }
}

function requireCount(count: number, what: string): void {
  if (count < 1 || count > MAX_CRITERIA) {
    throw new DoneRecordError(
      "invalid_input",
      `${what} has ${count} entries. A done record holds 1 to ${MAX_CRITERIA} criteria.`,
    );
  }
}

/** Convert one run dod check into a criterion with the same check. */
function criterionFromRunCheck(entry: RunDodCheck, reviewer: string | undefined): Criterion {
  const { id, ...check } = entry;
  const kind = checkKind(check);
  const tag = RUN_DOD_TAGS[kind];
  if ("human" in check) {
    const signer = requireReviewer(reviewer, "The run dod");
    return { id, text: check.human, tag, check: { human: signer } };
  }
  if ("run" in check) return { id, text: `${code(check.run)} passes.`, tag, check };
  if ("file" in check) return { id, text: fileText(check), tag, check };
  if ("diff" in check) {
    const { text, negative } = diffText(check);
    return negative === undefined ? { id, text, tag, check } : { id, text, tag, check, negative };
  }
  if ("tools" in check) {
    return { id, text: `The agent never calls ${anyOf(check.tools.deny.map(code))}.`, tag, check };
  }
  return {
    id,
    text: budgetText(check),
    tag,
    check,
    negative: "A run that goes over any of these limits fails.",
  };
}

/**
 * Convert a run dod from dod-spec.md into a done record. Each check becomes a
 * criterion with the same id and the same check. The dod's task, run, and lock
 * are dropped, and the record comes back unlocked. Pure.
 */
export function fromRunDod(dod: RunDod, target: ConvertTarget): DoneRecord {
  if (dod.dod !== 1) {
    throw new DoneRecordError("invalid_input", "The run dod is not version 1. Only `dod: 1` converts.");
  }
  requireTarget(target);
  requireCount(dod.checks.length, "The run dod");
  const seen = new Set<string>();
  for (const entry of dod.checks) {
    if (!CRITERION_ID_PATTERN.test(entry.id)) {
      throw new DoneRecordError(
        "invalid_input",
        `The check id "${entry.id}" is not a criterion id. Use lowercase letters, digits, and hyphens.`,
      );
    }
    if (seen.has(entry.id)) {
      throw new DoneRecordError("invalid_input", `Two checks share the id "${entry.id}".`);
    }
    seen.add(entry.id);
  }
  return {
    schema: DONE_RECORD_SCHEMA,
    item: target.item,
    lineage: target.lineage,
    criteria: dod.checks.map((entry) => criterionFromRunCheck(entry, target.reviewer)),
  };
}

/** One item of a definition of done from tasks-spec.md §8.1. */
export interface DefinitionOfDoneItem {
  text: string;
  kind: "check" | "review";
  tag: CriterionTag;
  /** Where the item came from. It is provenance and does not carry into the record. */
  source?: string;
}

/** Where a converted definition of done belongs, and the checks its check items run. */
export interface DefinitionOfDoneTarget extends ConvertTarget {
  /**
   * The check each check item runs, keyed by the criterion id the conversion
   * gives it: c1 for the first item, c2 for the second, and so on. A §8 item
   * says evidence can show it, not which check shows it.
   */
  checks?: Readonly<Record<string, Check>>;
  drafted_by?: DraftedBy;
}

/** A converted definition of done, and the check items that still need a check. */
export interface ConvertedDefinitionOfDone {
  record: DoneRecord;
  /** The ids of check items no check was given for. A person adds one before the record locks. */
  unresolved: string[];
}

/**
 * Convert a definition of done from tasks-spec.md §8 into a done record. Item
 * N becomes criterion cN with the item's text and tag. A check item takes its
 * check from `target.checks`. A review item takes a human check that the
 * reviewer signs. The record comes back unlocked. Pure.
 */
export function fromDefinitionOfDone(
  items: readonly DefinitionOfDoneItem[],
  target: DefinitionOfDoneTarget,
): ConvertedDefinitionOfDone {
  requireTarget(target);
  requireCount(items.length, "The definition of done");
  const checks = target.checks ?? {};
  const ids = items.map((_item, index) => `c${index + 1}`);
  for (const key of Object.keys(checks)) {
    const index = ids.indexOf(key);
    if (index < 0 || items[index]?.kind !== "check") {
      throw new DoneRecordError(
        "unknown_criterion",
        `The check for "${key}" names no check item. Key each check by its item's criterion id.`,
      );
    }
  }

  const unresolved: string[] = [];
  const criteria = items.map((entry, index): Criterion => {
    const id = `c${index + 1}`;
    const text = entry.text.trim();
    if (text.length === 0) {
      throw new DoneRecordError("invalid_input", `Item ${index + 1} has no text.`);
    }
    if (!CRITERION_TAGS.includes(entry.tag)) {
      throw new DoneRecordError("invalid_input", `Item ${index + 1} has the tag "${String(entry.tag)}".`);
    }
    if (entry.kind === "review") {
      const signer = requireReviewer(target.reviewer, "The definition of done");
      return { id, text, tag: entry.tag, check: { human: signer } };
    }
    if (entry.kind !== "check") {
      throw new DoneRecordError("invalid_input", `Item ${index + 1} has the kind "${String(entry.kind)}".`);
    }
    const check = checks[id];
    if (check === undefined) {
      unresolved.push(id);
      return { id, text, tag: entry.tag };
    }
    if ("human" in check) {
      throw new DoneRecordError(
        "invalid_input",
        `Item ${index + 1} is a check item, and a human check is a review. Give it an executable check.`,
      );
    }
    return { id, text, tag: entry.tag, check };
  });

  const record: DoneRecord = {
    schema: DONE_RECORD_SCHEMA,
    item: target.item,
    lineage: target.lineage,
    criteria,
  };
  if (target.drafted_by !== undefined) record.drafted_by = target.drafted_by;
  return { record, unresolved };
}

/** One concrete example in a witness record. */
export interface WitnessCase {
  name: string;
  inputs?: unknown;
  expected?: string;
  expect_verdict?: "REJECTED";
  reason?: string;
}

/** A witness record from witness-spec.md. Fields the conversion does not read are kept as data. */
export interface WitnessRecord {
  witness: {
    id: string;
    title?: string;
    requirement?: string;
    owner?: string;
    oracle_classes: OracleClass[];
    witnesses?: WitnessCase[];
    judgment_gated?: string[];
    /** The model that drafted the witness record. */
    drafted_by?: string;
    pre?: unknown;
    act?: unknown;
    post?: unknown;
    invariants?: unknown;
    budget?: unknown;
    funding?: unknown;
  };
}

/** Which criterion a witness oracle tests. */
export interface WitnessLink {
  criterion: string;
  class: OracleClass;
  /** The file that holds the oracle's evaluator or its expected output. */
  witness?: string;
}

/** How to attach a witness record's oracles and judgment-gated items. */
export interface AttachWitnessOptions {
  links: readonly WitnessLink[];
  /** The handle of the person who signs each judgment-gated item. */
  signer?: string;
  /** The triage decision to record with the witness's drafting model when the record has none. */
  decision?: TriageDecisionId;
}

/** A done record with a witness attached, and the oracle classes no criterion took. */
export interface AttachedWitness {
  record: DoneRecord;
  /** Oracle classes the witness names that no link attached. A person attaches them or drops them. */
  unattached: OracleClass[];
}

/** The first case that must be rejected, as a negative. */
function witnessNegative(cases: readonly WitnessCase[]): string | undefined {
  const rejected = cases.find((entry) => entry.expect_verdict === "REJECTED");
  if (rejected === undefined) return undefined;
  const reason = rejected.reason === undefined ? "" : ` with ${code(rejected.reason)}`;
  return `The ${code(rejected.name)} case fails${reason}.`;
}

function nextJudgmentId(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`j${n}`)) n += 1;
  const id = `j${n}`;
  taken.add(id);
  return id;
}

/** Work out the record's drafting model once the witness's is known. */
function mergeDraftedBy(
  record: DoneRecord,
  witness: WitnessRecord["witness"],
  decision: TriageDecisionId | undefined,
): DraftedBy | undefined {
  const model = witness.drafted_by;
  if (model === undefined) return record.drafted_by;
  if (model.length === 0) {
    throw new DoneRecordError("invalid_input", "The witness's drafted_by is empty. Name the drafting model.");
  }
  if (record.drafted_by !== undefined) {
    if (record.drafted_by.model !== model) {
      throw new DoneRecordError(
        "drafting_conflict",
        `The record was drafted by "${record.drafted_by.model}" and the witness by "${model}". A record has one drafting model.`,
      );
    }
    return record.drafted_by;
  }
  if (decision === undefined || !TRIAGE_ID_PATTERN.test(decision)) {
    throw new DoneRecordError(
      "invalid_input",
      `The witness was drafted by "${model}". Pass the triage decision (tri_…) to record with that model.`,
    );
  }
  return { model, decision };
}

/**
 * Attach a witness record's oracles to the criteria they test, and add each
 * judgment-gated item as a review criterion with a human check. The record
 * comes back unlocked, since its lock digest changes. Pure.
 */
export function attachWitness(
  record: DoneRecord,
  source: WitnessRecord,
  options: AttachWitnessOptions,
): AttachedWitness {
  const witness = source.witness;
  for (const cls of witness.oracle_classes) {
    if (!ORACLE_CLASSES.includes(cls)) {
      throw new DoneRecordError("invalid_input", `The witness names the oracle class "${String(cls)}".`);
    }
  }

  const { lock: _lock, ...unlocked } = record;
  const criteria = unlocked.criteria.map((criterion) => ({ ...criterion }));
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const negative = witnessNegative(witness.witnesses ?? []);
  const used = new Set<OracleClass>();

  for (const link of options.links) {
    if (!witness.oracle_classes.includes(link.class)) {
      throw new DoneRecordError(
        "invalid_input",
        `The witness does not name the oracle class "${link.class}". Link only the classes it names.`,
      );
    }
    const criterion = byId.get(link.criterion);
    if (criterion === undefined) {
      throw new DoneRecordError("unknown_criterion", `The record has no criterion "${link.criterion}".`);
    }
    if (criterion.oracle !== undefined) {
      throw new DoneRecordError(
        "invalid_input",
        `The criterion "${link.criterion}" already has an oracle. A criterion carries one.`,
      );
    }
    criterion.oracle = link.witness === undefined ? { class: link.class } : { class: link.class, witness: link.witness };
    if (criterion.negative === undefined && negative !== undefined && needsNegative(criterion.text)) {
      criterion.negative = negative;
    }
    used.add(link.class);
  }

  const gated = (witness.judgment_gated ?? []).map((text) => text.trim()).filter((text) => text.length > 0);
  if (gated.length > 0) {
    if (options.signer === undefined || !isActor(options.signer)) {
      throw new DoneRecordError(
        "invalid_input",
        "The witness has judgment-gated items, so the conversion needs a signer. Pass a workspace handle.",
      );
    }
    const taken = new Set(criteria.map((criterion) => criterion.id));
    for (const text of gated) {
      criteria.push({ id: nextJudgmentId(taken), text, tag: "review", check: { human: options.signer } });
    }
  }
  requireCount(criteria.length, "The record with the witness attached");

  const out: DoneRecord = { ...unlocked, criteria };
  const draftedBy = mergeDraftedBy(record, witness, options.decision);
  if (draftedBy !== undefined) out.drafted_by = draftedBy;
  return {
    record: out,
    unattached: witness.oracle_classes.filter((cls) => !used.has(cls)),
  };
}
