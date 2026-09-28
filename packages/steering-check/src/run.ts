// run.ts: the one entry point. It runs the checks a steering PR runs, in the
// order the spec gives, and gathers what each one found.
//
// A tree check reads one tree. With a base, the runner runs it on both trees
// and reports a head finding only when the steering PR brings it: its file
// changed, or the base did not have it. A problem already on the production
// branch does not fail a steering PR that leaves its file alone.
import { STEERING_CHECK_NAMES } from "@oxagen/oxagen/contracts/context.steering.shared";
import { authorityCheck } from "./checks/authority";
import { budgetCheck } from "./checks/budget";
import { cedarFiles, compileCheck } from "./checks/compile";
import { conflictsCheck } from "./checks/conflicts";
import { hashCheck } from "./checks/hash";
import { lineageCheck } from "./checks/lineage";
import { ownedCheck } from "./checks/owned";
import { referencesCheck } from "./checks/references";
import { schemaCheck } from "./checks/schema";
import { secretsCheck } from "./checks/secrets";
import { settingsCheck } from "./checks/settings";
import type { ChangeCheck, ChangeEnv, ChangeOutcome, TreeCheck, TreeEnv } from "./finding";
import { changedPaths } from "./repo";
import type {
  CheckInput,
  CheckReport,
  CheckResult,
  CheckStatus,
  Finding,
  SteeringCheckName,
} from "./types";

export { STEERING_CHECK_NAMES };

type Runner = { kind: "tree"; run: TreeCheck } | { kind: "change"; run: ChangeCheck };

/** Each check, and whether it reads one tree or the change. */
const RUNNERS: Record<SteeringCheckName, Runner> = {
  schema: { kind: "tree", run: schemaCheck },
  lineage: { kind: "tree", run: lineageCheck },
  hash: { kind: "tree", run: hashCheck },
  secrets: { kind: "tree", run: secretsCheck },
  conflicts: { kind: "tree", run: conflictsCheck },
  authority: { kind: "tree", run: authorityCheck },
  settings: { kind: "change", run: settingsCheck },
  references: { kind: "tree", run: referencesCheck },
  budget: { kind: "change", run: budgetCheck },
  compile: { kind: "tree", run: compileCheck },
  owned: { kind: "change", run: ownedCheck },
};

/** A finding's identity across the base and the head. The line is left out, so a moved line is the same finding. */
function findingKey(finding: Finding): string {
  return JSON.stringify([finding.check, finding.rule, finding.path, finding.field, finding.message]);
}

export function byPlace(a: Finding, b: Finding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
}

export function internalFinding(check: SteeringCheckName, error: unknown): Finding {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    check,
    rule: "internal",
    severity: "error",
    path: "",
    line: null,
    field: null,
    message: `The ${check} check stopped before it finished: ${reason}`,
    expected: `The ${check} check reads every file and reports what it finds.`,
    fix: "Run the checks again. If this check stops again, report it to Oxagen with a link to the steering PR.",
  };
}

export function countText(findings: readonly Finding[]): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  return parts.length === 0 ? "No findings." : `${parts.join(" and ")}.`;
}

export function statusOf(findings: readonly Finding[]): CheckStatus {
  if (findings.some((finding) => finding.severity === "error")) return "failed";
  return findings.length > 0 ? "warned" : "passed";
}

function result(check: SteeringCheckName, outcome: ChangeOutcome): CheckResult {
  if (outcome.skipped !== undefined) {
    return { check, status: "skipped", summary: `Skipped: ${outcome.skipped}.`, findings: [] };
  }
  const findings = [...outcome.findings].sort(byPlace);
  const summary = outcome.note === undefined ? countText(findings) : `${countText(findings)} ${outcome.note}`;
  return { check, status: statusOf(findings), summary, findings };
}

/** What the steering PR brings: every head finding in a changed file, and any other head finding the base does not have. */
export function brought(
  head: readonly Finding[],
  base: readonly Finding[],
  changed: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): Finding[] {
  const before = new Set(base.map(findingKey));
  return head.filter(
    (finding) => changed.has(finding.path) || removed.has(finding.path) || !before.has(findingKey(finding)),
  );
}

function runTree(check: TreeCheck, input: CheckInput, env: ChangeEnv): Finding[] {
  const head = check(input.files, env);
  if (input.base === null) return head;
  // The base's own base is not known, so the base runs as a tree on its own.
  const baseEnv: TreeEnv = { ...env, base: null };
  return brought(head, check(input.base, baseEnv), env.changed, env.removed);
}

function cedarNote(input: CheckInput): string | undefined {
  if (input.cedar !== undefined || cedarFiles(input.files).policies.size === 0) return undefined;
  return "Oxagen did not evaluate the Cedar policies, because no Cedar evaluator was passed in.";
}

function runOne(check: SteeringCheckName, input: CheckInput, env: ChangeEnv): CheckResult {
  const runner = RUNNERS[check];
  try {
    if (runner.kind === "change") return result(check, runner.run(env));
    const findings = runTree(runner.run, input, env);
    return result(check, { findings, note: check === "compile" ? cedarNote(input) : undefined });
  } catch (error) {
    return result(check, { findings: [internalFinding(check, error)] });
  }
}

/**
 * Run the checks a steering PR runs. It reads only what the input holds and
 * never throws: a check that throws reports one `internal` error, and the
 * other checks still run. The report passes when no finding is an error.
 */
export function runChecks(input: CheckInput): CheckReport {
  const { changed, removed } = changedPaths(input.files, input.base);
  const env: ChangeEnv = {
    head: input.files,
    base: input.base,
    index: input.index,
    context: input.context,
    health: input.health,
    changed,
    removed,
  };
  if (input.cedar !== undefined) env.cedar = input.cedar;
  if (input.servers !== undefined) env.servers = input.servers;
  const selected = new Set<SteeringCheckName>(input.checks ?? STEERING_CHECK_NAMES);
  const results: CheckResult[] = STEERING_CHECK_NAMES.map((check) =>
    selected.has(check)
      ? runOne(check, input, env)
      : { check, status: "skipped", summary: "Skipped: this run did not select it.", findings: [] },
  );
  const findings = results.flatMap((entry) => entry.findings);
  return {
    passed: !findings.some((finding) => finding.severity === "error"),
    results,
    findings,
  };
}
