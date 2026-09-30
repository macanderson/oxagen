// checks.ts: the six check kinds, each a pure function of the trace.
//
// A check never runs anything. The contained runtime ran the command and
// captured the files and the diff manifest. The gateway recorded the tool
// calls and the usage. A check reads those records and returns ok, the digest
// of what it read, and a reason when it fails.
//
// A check that cannot decide sets `error`. The done record never treats that
// as a pass (DONE_REASONS.HARNESS_ERROR).
import { matchesGlob } from "@oxagen/glob";
import { digestJcs } from "@oxagen/run-evidence";
import type { SignatureEvidence } from "../decide";
import {
  BUDGET_DEFAULT_STOP_ATTEMPTS,
  RUN_CHECK_DEFAULT_TIMEOUT_S,
  type BudgetCheck,
  type Check,
  type DiffCheck,
  type FileCheck,
  type HumanCheck,
  type RunCheck,
  type ToolsCheck,
} from "../types";
import { firstDenyRule } from "./tool-rules";
import type { CheckResult, ToolCallRecord, Trace } from "./types";

/** The command exited zero inside its timeout. */
export function evaluateRunCheck(check: RunCheck, trace: Trace): CheckResult {
  const timeoutS = check.timeout_s ?? RUN_CHECK_DEFAULT_TIMEOUT_S;
  const record = trace.runs[check.run];
  if (!record) {
    return {
      ok: false,
      error: true,
      reason: "HARNESS_ERROR",
      evidence: digestJcs({ kind: "run", command: check.run, recorded: false }),
    };
  }
  const evidence = digestJcs({
    kind: "run",
    command: check.run,
    timeoutS,
    exitCode: record.exitCode,
    signal: record.signal ?? null,
    durationS: record.durationS,
    stdout: record.stdout,
    stderr: record.stderr,
  });
  const killed =
    record.signal !== undefined ||
    record.exitCode === null ||
    record.durationS > timeoutS;
  if (killed) return { ok: false, error: true, reason: "HARNESS_ERROR", evidence };
  if (record.exitCode !== 0) return { ok: false, reason: "CHECK_FAILED", evidence };
  return { ok: true, evidence };
}

/**
 * The file exists, is absent, contains a string, or matches a digest. With no
 * condition set, the file must exist.
 */
export function evaluateFileCheck(check: FileCheck, trace: Trace): CheckResult {
  const { path, contains, sha256 } = check.file;
  const exists = check.file.exists ?? true;
  const record = trace.files[path];
  const evidence = digestJcs({
    kind: "file",
    path,
    sha256: record?.sha256 ?? null,
  });
  if (!exists) {
    return record
      ? { ok: false, reason: "CHECK_FAILED", evidence }
      : { ok: true, evidence };
  }
  if (!record) return { ok: false, reason: "CHECK_FAILED", evidence };
  if (sha256 !== undefined && record.sha256 !== sha256) {
    return { ok: false, reason: "CHECK_FAILED", evidence };
  }
  if (contains !== undefined) {
    // The runtime captured the hash but not the text, so nothing can decide.
    if (record.text === undefined) {
      return { ok: false, error: true, reason: "HARNESS_ERROR", evidence };
    }
    if (!record.text.includes(contains)) {
      return { ok: false, reason: "CHECK_FAILED", evidence };
    }
  }
  return { ok: true, evidence };
}

/** Every changed or new file matches an allow glob and no deny glob. */
export function evaluateDiffCheck(check: DiffCheck, trace: Trace): CheckResult {
  const diff = trace.diff;
  if (!diff) {
    return {
      ok: false,
      error: true,
      reason: "HARNESS_ERROR",
      evidence: digestJcs({ kind: "diff", recorded: false }),
    };
  }
  const allow = check.diff.allow ?? ["**"];
  const deny = check.diff.deny ?? [];
  const files = [...diff.files].sort();
  const outside = files.filter(
    (file) =>
      !allow.some((glob) => matchesGlob(glob, file)) ||
      deny.some((glob) => matchesGlob(glob, file)),
  );
  const evidence = digestJcs({ kind: "diff", base: diff.base, files, outside });
  return outside.length === 0
    ? { ok: true, evidence }
    : { ok: false, reason: "CHECK_FAILED", evidence };
}

/** One call a deny rule matched. */
export interface DeniedCall {
  /** The call's position in the gateway's record. */
  index: number;
  tool: string;
  rule: string;
}

/** The calls the deny rules match, in the order the gateway recorded them. */
export function deniedCalls(
  rules: readonly string[],
  calls: readonly ToolCallRecord[],
): DeniedCall[] {
  const denied: DeniedCall[] = [];
  calls.forEach((call, index) => {
    const rule = firstDenyRule(rules, call);
    if (rule !== undefined) denied.push({ index, tool: call.tool, rule });
  });
  return denied;
}

/** No tool call the gateway recorded matched a deny rule. */
export function evaluateToolsCheck(check: ToolsCheck, trace: Trace): CheckResult {
  const { tier, basis, toolCalls } = trace.gateway;
  const denied = deniedCalls(check.tools.deny, toolCalls);
  const evidence = digestJcs({
    kind: "tools",
    tier,
    basis,
    calls: toolCalls.map((call) => ({ tool: call.tool, input: call.input })),
    denied: denied.map((d) => ({ index: d.index, tool: d.tool, rule: d.rule })),
  });
  return denied.length === 0
    ? { ok: true, evidence }
    : { ok: false, reason: "TOOL_DENIED", evidence };
}

/**
 * Cost, tool calls, and minutes stayed at or under their limits, and the agent
 * tried to finish no more times than the set allows. A `usd` limit on a run
 * that reported no cost cannot be decided, and the check says so.
 */
export function evaluateBudgetCheck(check: BudgetCheck, trace: Trace): CheckResult {
  const { tier, basis, usage } = trace.gateway;
  const limits = check.budget;
  const stopAttempts = limits.stop_attempts ?? BUDGET_DEFAULT_STOP_ATTEMPTS;
  const exceeded: string[] = [];
  let undecided = false;
  if (limits.usd !== undefined) {
    if (usage.usd === null) undecided = true;
    else if (usage.usd > limits.usd) exceeded.push("usd");
  }
  if (limits.tool_calls !== undefined && usage.toolCalls > limits.tool_calls) {
    exceeded.push("tool_calls");
  }
  if (limits.minutes !== undefined && usage.minutes > limits.minutes) {
    exceeded.push("minutes");
  }
  const exhausted = usage.stopAttempts > stopAttempts;
  const evidence = digestJcs({
    kind: "budget",
    tier,
    basis,
    usage: {
      usd: usage.usd,
      toolCalls: usage.toolCalls,
      minutes: usage.minutes,
      stopAttempts: usage.stopAttempts,
    },
    limits: {
      usd: limits.usd ?? null,
      tool_calls: limits.tool_calls ?? null,
      minutes: limits.minutes ?? null,
      stop_attempts: stopAttempts,
    },
    exceeded,
    exhausted,
    undecided,
  });
  if (exceeded.length > 0) return { ok: false, reason: "BUDGET_EXCEEDED", evidence };
  if (exhausted) return { ok: false, reason: "ATTEMPTS_EXHAUSTED", evidence };
  if (undecided) return { ok: false, error: true, reason: "HARNESS_ERROR", evidence };
  return { ok: true, evidence };
}

/** The named person signed. Anyone else's signature leaves the check pending. */
export function evaluateHumanCheck(
  check: HumanCheck,
  signature: SignatureEvidence | undefined,
): CheckResult {
  const signed = signature !== undefined && signature.by === check.human;
  const evidence = digestJcs({
    kind: "human",
    signer: check.human,
    signature: signature ? { by: signature.by, at: signature.at } : null,
  });
  return signed
    ? { ok: true, evidence }
    : { ok: false, reason: "HUMAN_PENDING", evidence };
}

/** Run the evaluator for a check's kind. */
export function evaluateCheck(
  check: Check,
  trace: Trace,
  signature?: SignatureEvidence,
): CheckResult {
  if ("run" in check) return evaluateRunCheck(check, trace);
  if ("file" in check) return evaluateFileCheck(check, trace);
  if ("diff" in check) return evaluateDiffCheck(check, trace);
  if ("tools" in check) return evaluateToolsCheck(check, trace);
  if ("budget" in check) return evaluateBudgetCheck(check, trace);
  return evaluateHumanCheck(check, signature);
}
