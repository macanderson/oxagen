/**
 * The Stella hook adapter (verified 2026-09-15 against macanderson/stella:
 * `crates/stella-core/src/hooks/payload.rs`, `hooks/decision.rs`, `bus.rs`).
 * Stella's hook surface differs from Claude Code's in both directions, and
 * this module is the one place that knows it, so the recorder, the policy
 * evaluator and the daemon keep reading one payload shape.
 *
 * In: `{ event, cwd, tool?: {name, input, read_only}, toolResult?,
 * finalText?, prompt?, subagent?: {agentId, instructionPreview, depth},
 * subagentResult?, reason? }` on stdin. There is no session id, no tool-use
 * id and no transcript path, and no environment variable names the session
 * either. So the adapter synthesizes them:
 *
 *   - `session_id = "stella-<pid>-<instance>"`, where the pid is the Stella
 *     process that ran the hook and the instance is a digest of that
 *     process's start time. Stella spawns `bash -c <command>`; bash either
 *     execs the hook (the parent is Stella) or forks it (the parent is the
 *     shell, and Stella is the grandparent). The same pid goes to the daemon
 *     as `TACHO_HARNESS_PID`, so the registry sweep seals the chain when
 *     Stella exits: Stella has no SessionEnd. The start time is what keeps a
 *     reused pid off the retained sealed chain of the run that had it before.
 *   - `tool_use_id` is a digest of the tool name and input, so a PreToolUse
 *     and its PostToolUse pair. Two identical calls in one session digest
 *     alike, so this id names the call, not the invocation; the daemon
 *     numbers each invocation from the chain seq when the PreToolUse lands
 *     (`invocationToolUseId`), because the trace oracles read a repeated id
 *     as one call executed twice.
 *
 * Out: Stella reads `{"action":"allow"|"deny"|"require_approval", ...}`.
 * A JSON object without `action` is informational, but a malformed decision
 * or a non-zero exit is a deny, so every answer is either a valid decision,
 * `{}`, or (for SessionStart) plain text: Stella appends SessionStart
 * stdout to the system prompt verbatim, so a JSON document there would
 * become prompt text. SessionStart is not a veto point either, so a blocked
 * host or session cannot be stopped there; it is told why in prose, and
 * PreToolUse denies every tool call while the block holds.
 */
import { spawnSync } from "node:child_process";
import { digestJcs, type JsonValue } from "../digest";
import { digestText } from "./context";

/** What `ps` says about one process. */
export interface ProcessInfo {
  ppid: number;
  comm: string;
}

export type PsLookup = (
  pid: number,
  timeoutMs?: number,
) => ProcessInfo | undefined;

/** Parse `ps -o ppid=,comm=` output: `  812 /bin/zsh`. */
export function parsePsLine(stdout: string): ProcessInfo | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/m.exec(stdout);
  if (match === null) return undefined;
  return { ppid: Number(match[1]), comm: match[2] as string };
}

/** The real lookup: one `ps` call with a short timeout, stdin closed. */
export function psLookup(
  pid: number,
  timeoutMs = 2_000,
): ProcessInfo | undefined {
  const result = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
  });
  if (result.status !== 0 || typeof result.stdout !== "string")
    return undefined;
  return parsePsLine(result.stdout);
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/**
 * The Stella process's pid, from the hook's parent pid: the parent itself,
 * or its parent when the parent is the shell Stella ran the command
 * through. `ps` reports login shells as `-zsh` and macOS reports full
 * paths, so the name is reduced to a bare basename first. On Windows there
 * is no `ps` and Stella's shell does not fork the same way: the parent is
 * used as is.
 */
export function stellaHarnessPid(
  parentPid: number,
  platform: NodeJS.Platform,
  lookup: PsLookup = psLookup,
): number {
  if (platform === "win32") return parentPid;
  const parent = lookup(parentPid);
  if (parent === undefined) return parentPid;
  const name = (parent.comm.split("/").pop() ?? "").replace(/^-/, "");
  return SHELLS.has(name) && parent.ppid > 1 ? parent.ppid : parentPid;
}

/**
 * A deterministic tool-use id from the call itself, so Pre and Post pair.
 * It identifies the call, not the invocation: the daemon adds the number
 * that tells two identical calls apart.
 */
export function stellaToolUseId(name: string, input: unknown): string {
  const digest = digestJcs({
    name,
    input: (input ?? null) as JsonValue,
  } as JsonValue);
  return `stella_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

/**
 * A short token for one process instance, from its start time. Undefined for
 * an empty line, which is what `ps` prints for a pid that is gone.
 */
export function startInstanceToken(lstart: string): string | undefined {
  const text = lstart.trim();
  if (text.length === 0) return undefined;
  return digestJcs(text).slice("sha256:".length, "sha256:".length + 12);
}

/**
 * The start time of a process as an instance token: one `ps -o lstart=` call
 * (BSD and GNU `ps` both carry `lstart`) with a short timeout, the same shape
 * as `psLookup`. Undefined when `ps` cannot answer, and the caller then falls
 * back to the bare pid form.
 */
export function psStartInstance(pid: number): string | undefined {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string")
    return undefined;
  return startInstanceToken(result.stdout);
}

/**
 * The synthetic session id for a Stella run. `instance` distinguishes one
 * process instance from the next: pids are reused, and the daemon retains a
 * sealed record for days, so `stella-<pid>` alone can put a new run on a
 * finished run's chain and record it as a resume. Without an instance (no
 * `ps`, or Windows) the id falls back to the bare pid form.
 */
export function stellaSessionId(pid: number, instance?: string): string {
  return instance === undefined ? `stella-${pid}` : `stella-${pid}-${instance}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stella's payload in Claude Code's hook shape. Renamed members are
 * replaced by their Claude Code names; every other member, and the parts of
 * a renamed member Claude Code has no name for (`tool.read_only`, the
 * `subagent` object), pass through so the recorder keeps them as attributes.
 * The one exception is `subagent.instructionPreview`, which is prompt text
 * and leaves as a digest and a length. A document that is not a Stella
 * payload (no string `event`) is returned
 * unchanged and fails the hook schema the way any junk does.
 */
export function translateStellaPayload(
  raw: unknown,
  pid: number,
  instance?: string,
): unknown {
  if (!isRecord(raw) || typeof raw["event"] !== "string") return raw;
  const { event, tool, toolResult, finalText, subagentResult, ...rest } = raw;
  const out: Record<string, unknown> = {
    ...rest,
    session_id: stellaSessionId(pid, instance),
    hook_event_name: event,
  };
  if (isRecord(tool)) {
    if (typeof tool["name"] === "string") {
      out["tool_name"] = tool["name"];
      out["tool_use_id"] = stellaToolUseId(tool["name"], tool["input"]);
    }
    if (isRecord(tool["input"])) out["tool_input"] = tool["input"];
    else if (tool["input"] !== undefined)
      out["tool_input"] = { value: tool["input"] };
    if (typeof tool["read_only"] === "boolean")
      out["tool_read_only"] = tool["read_only"];
  }
  if (toolResult !== undefined) out["tool_response"] = toolResult;
  if (finalText !== undefined) out["last_assistant_message"] = finalText;
  if (subagentResult !== undefined) out["subagent_result"] = subagentResult;
  const subagent = rest["subagent"];
  if (isRecord(subagent)) {
    if (typeof subagent["agentId"] === "string")
      out["agent_id"] = subagent["agentId"];
    out["subagent"] = digestSubagentInstruction(subagent);
  }
  return out;
}

/**
 * The `subagent` object with its `instructionPreview` replaced by a digest
 * and a length. The preview is the opening of the child's instruction, which
 * is prompt text: the parent's task, in the parent's words, sometimes with
 * the file it pasted. Everything else in the object passes through to the
 * recorder's leftover attributes, and before this the preview went with it,
 * verbatim, into `hook.subagent` on every SubagentStart and SubagentStop.
 * The digest still lets two hooks agree they saw the same instruction.
 */
function digestSubagentInstruction(
  subagent: Record<string, unknown>,
): Record<string, unknown> {
  const { instructionPreview, ...keep } = subagent;
  if (typeof instructionPreview !== "string") return keep;
  return {
    ...keep,
    instruction_preview_digest: digestText(instructionPreview),
    instruction_preview_length: instructionPreview.length,
  };
}

function reasonOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Claude Code's answer as Stella's stdout (with its trailing newline, or
 * empty). Precedence runs from most to least restrictive, so a document
 * carrying two answers never fails open: deny > require_approval > stop >
 * allow.
 *
 *   - `permissionDecision: "deny"` → `deny` with the reason;
 *   - `permissionDecision: "ask"` → `require_approval`;
 *   - a stop (`continue: false`, or `decision: "block"`): on SessionStart
 *     the reason as prompt text ("Oxagen: <reason> Tool calls will be
 *     refused."), because Stella cannot veto a session start and PreToolUse
 *     refuses every call for a suspended, revoked or paused host and a
 *     paused or cancelled session; on any other event `deny`;
 *   - `permissionDecision: "allow"` → `allow`;
 *   - SessionStart `additionalContext` → that text, which Stella adds to the
 *     system prompt;
 *   - anything else → `{}` (no decision), or nothing for SessionStart.
 */
export function stellaAnswer(
  response: Record<string, unknown>,
  event: string,
): string {
  const specific = isRecord(response["hookSpecificOutput"])
    ? response["hookSpecificOutput"]
    : {};
  const permission = specific["permissionDecision"];
  const permissionReason = specific["permissionDecisionReason"];
  const decide = (decision: Record<string, unknown>): string =>
    `${JSON.stringify(decision)}\n`;
  if (permission === "deny")
    return decide({
      action: "deny",
      reason: reasonOf(permissionReason, "Denied by Oxagen policy."),
    });
  if (permission === "ask")
    return decide({
      action: "require_approval",
      reason: reasonOf(permissionReason, "Oxagen policy asks for approval."),
    });
  const stopped = response["continue"] === false;
  if (stopped || response["decision"] === "block") {
    const reason = stopped ? response["stopReason"] : response["reason"];
    if (event === "SessionStart")
      return `Oxagen: ${reasonOf(reason, "This session is stopped by its Oxagen operator.")} Tool calls will be refused.\n`;
    return decide({
      action: "deny",
      reason: reasonOf(
        reason,
        stopped ? "Stopped by Oxagen policy." : "Blocked by Oxagen policy.",
      ),
    });
  }
  if (permission === "allow") return decide({ action: "allow" });
  if (event === "SessionStart") {
    const context = specific["additionalContext"];
    return typeof context === "string" && context.length > 0
      ? `${context}\n`
      : "";
  }
  return "{}\n";
}

/**
 * Parse a daemon answer body, or undefined when the body is not a JSON
 * object. The three cases must stay apart: an empty object (`"{}"`) is a
 * real answer that carries no decision; a blank or whitespace-only body
 * is no answer at all (the daemon sent nothing); a truncated or
 * non-object body is also no answer. A harness that reads an allow out of
 * either fault would let a tool call through on a serialization miss.
 */
export function tryParseAnswerBody(
  body: string,
): Record<string, unknown> | undefined {
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a daemon answer body; anything that is not a JSON object answers nothing. */
export function parseAnswerBody(body: string): Record<string, unknown> {
  return tryParseAnswerBody(body) ?? {};
}
