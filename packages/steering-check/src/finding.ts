// finding.ts: the shapes each check takes, and the helper that builds a
// finding with its fields in one order.
import type {
  CedarHooks,
  CheckContext,
  CheckInput,
  Finding,
  IndexRecord,
  ServerReaders,
  Severity,
  SteeringCheckName,
  SteeringTree,
} from "./types";

/** A finding before its check is set. Severity is `error` unless it says otherwise. */
export type FindingInit = Omit<Finding, "check" | "severity"> & { severity?: Severity };

/** A function that builds findings for one check. */
export function finder(check: SteeringCheckName): (init: FindingInit) => Finding {
  return (init) => {
    const finding: Finding = {
      check,
      rule: init.rule,
      severity: init.severity ?? "error",
      path: init.path,
      line: init.line,
      field: init.field,
      message: init.message,
      expected: init.expected,
      fix: init.fix,
    };
    if (init.detail !== undefined) finding.detail = init.detail;
    return finding;
  };
}

/** What a check that reads one tree sees besides the tree. */
export interface TreeEnv {
  base: SteeringTree | null;
  index: { records: readonly IndexRecord[] } | null;
  context: CheckContext;
  cedar?: CedarHooks;
  servers?: ServerReaders;
}

/**
 * A check that reads one tree. The runner runs it on the head and on the
 * base, and reports only what the change brings.
 */
export type TreeCheck = (tree: SteeringTree, env: TreeEnv) => Finding[];

/** What a check that reads the change sees. */
export interface ChangeEnv extends TreeEnv {
  head: SteeringTree;
  changed: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  health: CheckInput["health"];
}

/** What a change check returns: its findings, or why it did not run, and a note for the summary. */
export interface ChangeOutcome {
  findings: Finding[];
  skipped?: string;
  note?: string;
}

/** A check that compares the head with the base. */
export type ChangeCheck = (env: ChangeEnv) => ChangeOutcome;

/** A message with its first letter in capitals and a period at the end. */
export function sentence(message: string): string {
  const trimmed = message.trim();
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.?]$/.test(first) ? first : `${first}.`;
}
