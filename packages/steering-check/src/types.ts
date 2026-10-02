// types.ts: what the checks take and what they return.
//
// The package does no I/O. The caller reads the steering PR's head and base
// trees, the published index, and what Oxagen knows outside the repository,
// and passes them in. The server and `oxagen check` pass the same shapes.
import type { SteeringCheckName } from "@oxagen/oxagen/contracts/context.steering.shared";
import type { FileIssue } from "@oxagen/oxagen/steering-repo";

export type { SteeringCheckName };

/** A file tree: each path, relative to the repository root, and its text. */
export type SteeringTree = ReadonlyMap<string, string>;

/**
 * One published record, as the index holds it. It is the part of a bundle
 * record the checks read, so a bundle record passes as one.
 */
export interface IndexRecord {
  lineage: string;
  path: string;
  id: string;
  hash: string;
  kind: string;
  effect?: string | null;
  /** The record's statement, when the index keeps it. The conflicts check reads it. */
  statement?: string | null;
}

/** What Oxagen knows outside the repository. The references check resolves against it. */
export interface CheckContext {
  /** Runtime slugs enrolled in Oxagen. */
  runtimes: readonly string[];
  /** Member handles in the organization. */
  members: readonly string[];
  /** Team slugs in the organization. */
  teams: readonly string[];
  /** Reviewer group slugs in the organization. */
  groups: readonly string[];
  /** Credential names in the vault. */
  credentials: readonly string[];
}

/** One setting on the host that differs from Oxagen's baseline. */
export interface SettingsDifferenceInput {
  setting: string;
  expected: unknown;
  actual: unknown;
  changed_by?: string | null;
  changed_at?: string | null;
}

/** A finding a Cedar hook returns. `path` names the policy or test file. */
export interface CedarIssue {
  path: string;
  line: number | null;
  message: string;
}

/**
 * The Cedar evaluator, passed in by the caller. The package holds no Cedar
 * engine, so without these hooks the Cedar half of `compile` is skipped.
 */
export interface CedarHooks {
  /** Parse one policy file. */
  parse: (path: string, text: string) => readonly { line: number | null; message: string }[];
  /** Validate every policy file against the schema. */
  validate: (policies: ReadonlyMap<string, string>, schema: string) => readonly CedarIssue[];
  /** Run every `.tests.jsonl` file against the policies. */
  test: (
    policies: ReadonlyMap<string, string>,
    schema: string,
    tests: ReadonlyMap<string, string>,
  ) => readonly CedarIssue[];
}

/** A server file read against its full schema: nothing wrong, or every issue. */
export type ServerFileOutcome = { ok: true } | { ok: false; issues: readonly FileIssue[] };

/** Whether a server's lock, as a steering PR adds or changes it, is a lock Oxagen writes, and if not, why. */
export type LockOutcome = { ok: true } | { ok: false; problems: readonly string[] };

/**
 * Readers for the files under tools/servers/<name>/. MCP Studio owns their
 * schemas, and the caller passes its readers in. Without a reader, the
 * schema check reads only the TOML syntax.
 *
 * Only Oxagen writes tools.lock.json, and it writes the lock into the
 * steering PR that Studio's Review or a sync opens. `lock` tells the owned
 * check whether the lock the head holds is one Oxagen writes for the folder
 * against the base. Without it, the owned check refuses every change to a
 * lock, because it cannot tell Oxagen's lock from a hand edit.
 */
export interface ServerReaders {
  server?: (text: string) => ServerFileOutcome;
  tools?: (text: string) => ServerFileOutcome;
  lock?: (name: string, head: SteeringTree, base: SteeringTree) => LockOutcome;
}

/** Everything the checks read. */
export interface CheckInput {
  /** The steering PR's head tree. */
  files: SteeringTree;
  /** The production branch the PR merges into. Null checks the head tree whole. */
  base: SteeringTree | null;
  /** The published index, or null before the first publish. */
  index: { records: readonly IndexRecord[] } | null;
  context: CheckContext;
  /**
   * The host's settings against the baseline. Null skips the settings check,
   * such as for `oxagen check` on a laptop.
   */
  health: { differences: readonly SettingsDifferenceInput[] } | null;
  cedar?: CedarHooks;
  servers?: ServerReaders;
  /** Run only these checks. Every check runs when unset. */
  checks?: readonly SteeringCheckName[];
}

export type Severity = "error" | "warning";

/** One thing a check found. An agent can act on it without reading the check. */
export interface Finding {
  check: SteeringCheckName;
  /** The rule's name within the check, such as `stale-stamp`. */
  rule: string;
  severity: Severity;
  /** The file, or the setting for a settings finding. */
  path: string;
  /** 1-based, or null when the finding has no line. */
  line: number | null;
  /** The field's dot-joined path, or null. */
  field: string | null;
  /** What is wrong. */
  message: string;
  /** What the rule expects. */
  expected: string;
  /** What to do. */
  fix: string;
  /** Numbers a formatter or an agent reads, such as the budget's totals. */
  detail?: Record<string, unknown>;
}

export type CheckStatus = "passed" | "failed" | "warned" | "skipped";

/** One check's outcome. */
export interface CheckResult {
  check: SteeringCheckName;
  status: CheckStatus;
  summary: string;
  findings: Finding[];
}

/** Every check's outcome. `passed` is false when any finding is an error. */
export interface CheckReport {
  passed: boolean;
  results: CheckResult[];
  findings: Finding[];
}
