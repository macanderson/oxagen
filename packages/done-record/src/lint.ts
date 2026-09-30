// lint.ts: the rules a done record must pass before anyone can lock it.
//
// agent-work-spec.html (Done record, Lint) sets three rules:
//
// - At least one criterion has a run check or an executable oracle. A record
//   with nothing to execute is a wish (dod-spec.md).
// - A criterion whose text names a threshold, a boundary, or "only" has a
//   negative (witness-spec.md).
// - Every oracle class and check kind is one the registry knows, and every
//   evaluator is pinned by digest.
//
// Lint also refuses two criteria with one id and more than MAX_CRITERIA
// criteria, since decide keys evidence by id. The JSON Schema checks the
// record's shape. Lint checks what the schema cannot express.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { checkKind, isSha256 } from "./patterns";
import {
  MAX_CRITERIA,
  type CheckKind,
  type Criterion,
  type DoneRecord,
  type OracleClass,
} from "./types";

/**
 * The oracle classes that count as an executable oracle for the first rule.
 * The spec names the class `executable`. Widen this list, not the rule, if
 * the spec later counts other classes.
 */
export const EXECUTABLE_ORACLE_CLASSES: readonly OracleClass[] = ["executable"];

/**
 * One evaluator the registry knows: its pinned digest, or null while the
 * evaluator does not exist yet. A criterion can name a class whose evaluator
 * is null. It stays held until the evaluator exists.
 */
export type EvaluatorPin = Sha256Digest | null;

/** The oracle classes and check kinds the verify stage can run, with each evaluator's pin. */
export interface EvaluatorRegistry {
  oracles: Partial<Record<OracleClass, EvaluatorPin>>;
  checks: Partial<Record<CheckKind, EvaluatorPin>>;
}

/** The rules lint applies. */
export const LINT_RULES = {
  NOTHING_TO_EXECUTE: "No criterion has a run check or an executable oracle.",
  NEGATIVE_MISSING:
    "The criterion names a threshold, a boundary, or \"only\" and has no negative.",
  UNKNOWN_EVALUATOR: "The registry does not know this oracle class or check kind.",
  UNPINNED_EVALUATOR: "The registry's evaluator for this class or kind is not pinned by digest.",
  DUPLICATE_CRITERION: "Two criteria share this id.",
  TOO_MANY_CRITERIA: `The record has more than ${MAX_CRITERIA} criteria.`,
} as const;
export type LintRule = keyof typeof LINT_RULES;

/** One rule a record breaks. */
export interface LintIssue {
  rule: LintRule;
  /** The criterion the issue is about, when it is about one. */
  criterion?: string;
  message: string;
}

/** The result of lint. A record locks only when `ok` is true. */
export interface LintResult {
  ok: boolean;
  issues: LintIssue[];
}

// Code spans and issue references name things. They are not thresholds.
const CODE_SPAN = /`[^`]*`/g;
const ISSUE_REF = /#\d+/g;
const ONLY = /\bonly\b/i;
const DIGIT = /\d/;
const THRESHOLD_SYMBOL = /[%<>≤≥]/;
const THRESHOLD_WORDS =
  /\b(?:at least|at most|more than|less than|fewer than|greater than|no more than|no fewer than|exceeds?|exceeded|exceeding|maximum|minimum|limits?|thresholds?|boundary|boundaries|percent)\b/i;

/**
 * True when a criterion's text names a threshold, a boundary, or "only", so
 * lint asks for a negative. A number counts as a threshold. The test is
 * deliberately wide: a false positive costs the author one sentence, and a
 * false negative lets a boundary through untested.
 */
export function needsNegative(text: string): boolean {
  const prose = text.replace(CODE_SPAN, " ").replace(ISSUE_REF, " ");
  return (
    ONLY.test(prose) ||
    DIGIT.test(prose) ||
    THRESHOLD_SYMBOL.test(prose) ||
    THRESHOLD_WORDS.test(prose)
  );
}

/** True when a criterion has a run check or an executable oracle. */
export function isExecutable(criterion: Criterion): boolean {
  if (criterion.check !== undefined && checkKind(criterion.check) === "run") {
    return true;
  }
  return (
    criterion.oracle !== undefined &&
    EXECUTABLE_ORACLE_CLASSES.includes(criterion.oracle.class)
  );
}

function pinIssue(
  pin: EvaluatorPin | undefined,
  name: string,
  criterion: string,
): LintIssue | undefined {
  if (pin === undefined) {
    return {
      rule: "UNKNOWN_EVALUATOR",
      criterion,
      message: `${LINT_RULES.UNKNOWN_EVALUATOR} It names ${name}.`,
    };
  }
  if (pin !== null && !isSha256(pin)) {
    return {
      rule: "UNPINNED_EVALUATOR",
      criterion,
      message: `${LINT_RULES.UNPINNED_EVALUATOR} It names ${name}.`,
    };
  }
  return undefined;
}

/** Lint a done record against the evaluator registry. Pure. */
export function lint(record: DoneRecord, registry: EvaluatorRegistry): LintResult {
  const issues: LintIssue[] = [];

  if (record.criteria.length > MAX_CRITERIA) {
    issues.push({ rule: "TOO_MANY_CRITERIA", message: LINT_RULES.TOO_MANY_CRITERIA });
  }
  if (!record.criteria.some(isExecutable)) {
    issues.push({ rule: "NOTHING_TO_EXECUTE", message: LINT_RULES.NOTHING_TO_EXECUTE });
  }

  const seen = new Set<string>();
  for (const criterion of record.criteria) {
    const id = criterion.id;
    if (seen.has(id)) {
      issues.push({ rule: "DUPLICATE_CRITERION", criterion: id, message: LINT_RULES.DUPLICATE_CRITERION });
    }
    seen.add(id);

    if (criterion.negative === undefined && needsNegative(criterion.text)) {
      issues.push({ rule: "NEGATIVE_MISSING", criterion: id, message: LINT_RULES.NEGATIVE_MISSING });
    }
    if (criterion.check !== undefined) {
      const kind = checkKind(criterion.check);
      const issue = pinIssue(registry.checks[kind], `the ${kind} check`, id);
      if (issue) issues.push(issue);
    }
    if (criterion.oracle !== undefined) {
      const cls = criterion.oracle.class;
      const issue = pinIssue(registry.oracles[cls], `the ${cls} oracle`, id);
      if (issue) issues.push(issue);
    }
  }

  return { ok: issues.length === 0, issues };
}
