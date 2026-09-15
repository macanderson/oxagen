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
 *   - `session_id = "stella-<pid>"`, where the pid is the Stella process that
 *     ran the hook. Stella spawns `bash -c <command>`; bash either execs the
 *     hook (the parent is Stella) or forks it (the parent is the shell, and
 *     Stella is the grandparent). The same pid goes to the daemon as
 *     `TACHO_HARNESS_PID`, so the registry sweep seals the chain when Stella
 *     exits: Stella has no SessionEnd.
 *   - `tool_use_id` is a digest of the tool name and input, so a PreToolUse
 *     and its PostToolUse pair. Two identical calls in one session share an
 *     id; they are still recorded in order.
 *
 * Out: Stella reads `{"action":"allow"|"deny"|"require_approval", ...}`.
 * A JSON object without `action` is informational, but a malformed decision
 * or a non-zero exit is a deny, so every answer is either a valid decision,
 * `{}`, or (for SessionStart) plain text: Stella appends SessionStart
 * stdout to the system prompt verbatim, so a JSON document there would
 * become prompt text.
 */
import { spawnSync } from "node:child_process";
import { digestJcs, type JsonValue } from "../digest";

/** What `ps` says about one process. */
export interface ProcessInfo {
  ppid: number;
  comm: string;
}

export type PsLookup = (pid: number) => ProcessInfo | undefined;

/** Parse `ps -o ppid=,comm=` output: `  812 /bin/zsh`. */
export function parsePsLine(stdout: string): ProcessInfo | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/m.exec(stdout);
  if (match === null) return undefined;
  return { ppid: Number(match[1]), comm: match[2] as string };
}

/** The real lookup: one `ps` call with a short timeout, stdin closed. */
export function psLookup(pid: number): ProcessInfo | undefined {
  const result = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
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

/** A deterministic tool-use id from the call itself, so Pre and Post pair. */
export function stellaToolUseId(name: string, input: unknown): string {
  const digest = digestJcs({
    name,
    input: (input ?? null) as JsonValue,
  } as JsonValue);
  return `stella_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

export function stellaSessionId(pid: number): string {
  return `stella-${pid}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stella's payload in Claude Code's hook shape. Renamed members are
 * replaced by their Claude Code names; every other member, and the parts of
 * a renamed member Claude Code has no name for (`tool.read_only`, the
 * `subagent` object), pass through so the recorder keeps them as attributes.
 * A document that is not a Stella payload (no string `event`) is returned
 * unchanged and fails the hook schema the way any junk does.
 */
export function translateStellaPayload(raw: unknown, pid: number): unknown {
  if (!isRecord(raw) || typeof raw["event"] !== "string") return raw;
  const { event, tool, toolResult, finalText, subagentResult, ...rest } = raw;
  const out: Record<string, unknown> = {
    ...rest,
    session_id: stellaSessionId(pid),
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
  if (isRecord(subagent) && typeof subagent["agentId"] === "string")
    out["agent_id"] = subagent["agentId"];
  return out;
}

function reasonOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Claude Code's answer as Stella's stdout (with its trailing newline, or
 * empty). The mapping, first match wins:
 *
 *   - `permissionDecision: "deny"` → `deny` with the reason;
 *   - `permissionDecision: "ask"` → `require_approval`;
 *   - `permissionDecision: "allow"` → `allow`;
 *   - `decision: "block"` (UserPromptSubmit) → `deny`;
 *   - `continue: false` (SessionStart) → `deny` with the stop reason;
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
  let decision: Record<string, unknown> | undefined;
  if (permission === "deny")
    decision = {
      action: "deny",
      reason: reasonOf(permissionReason, "Denied by Oxagen policy."),
    };
  else if (permission === "ask")
    decision = {
      action: "require_approval",
      reason: reasonOf(permissionReason, "Oxagen policy asks for approval."),
    };
  else if (permission === "allow") decision = { action: "allow" };
  else if (response["decision"] === "block")
    decision = {
      action: "deny",
      reason: reasonOf(response["reason"], "Blocked by Oxagen policy."),
    };
  else if (response["continue"] === false)
    decision = {
      action: "deny",
      reason: reasonOf(response["stopReason"], "Stopped by Oxagen policy."),
    };
  if (decision !== undefined) return `${JSON.stringify(decision)}\n`;
  if (event === "SessionStart") {
    const context = specific["additionalContext"];
    return typeof context === "string" && context.length > 0
      ? `${context}\n`
      : "";
  }
  return "{}\n";
}

/** Parse a daemon answer body; anything that is not a JSON object answers nothing. */
export function parseAnswerBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body.trim() || "{}") as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
