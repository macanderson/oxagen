/**
 * hooks.ts — The lifecycle hook engine for the CLI agent loop.
 *
 * Hooks are shell commands declared in `settings.json` that fire on agent
 * lifecycle events. They receive the event payload as JSON on stdin (Claude Code
 * parity), so a hook can inspect what the agent is about to do.
 *
 * Three events are wired today, each with distinct, load-bearing behavior:
 *
 *   - SessionStart  runs once before the turn. Anything a hook prints to stdout
 *                   is appended to the system prompt as additional context
 *                   (e.g. inject the current sprint, on-call notes, a changelog).
 *   - PreToolUse    runs before a tool executes. A non-zero exit BLOCKS the tool
 *                   — the model receives the hook's message instead of running it
 *                   (e.g. forbid `git push`, gate writes to protected paths).
 *   - PostToolUse   runs after a tool executes (side effects only — auto-format a
 *                   file after write_file, emit a notification). Never blocks.
 *
 * Matchers are globs over the tool name (PreToolUse / PostToolUse). SessionStart
 * ignores the matcher and runs every action.
 */
import { spawn } from "node:child_process";
import { matchGlob } from "@oxagen/mcp-config/permissions";
import type { HookAction, HookEvent, HookMatcher, Hooks } from "./schema.js";

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * Per-stream ceiling on what one hook's output may accumulate in memory.
 * SessionStart stdout is appended verbatim to the system prompt and PreToolUse
 * stderr becomes the block reason, so a hook that streams without bound (a
 * runaway `cat`, a chatty build tool) would otherwise grow the REPL's heap for
 * the whole timeout window. Past the cap, extra bytes are dropped and a marker
 * is appended — the same "cap and mark" idiom the diff panel uses.
 */
const MAX_HOOK_STREAM_BYTES = 256 * 1024;

export interface HookPayload {
  event: HookEvent;
  cwd: string;
  /** Present for PreToolUse / PostToolUse. */
  tool?: { name: string; input: unknown };
  /** Present for PostToolUse: the (clipped) result string the tool returned. */
  toolResult?: string;
}

export interface HookRunOutcome {
  /** PreToolUse only: a hook blocked the tool (non-zero exit). */
  blocked: boolean;
  /** Human-readable reason when blocked (hook stderr/stdout). */
  reason?: string;
  /** Concatenated stdout of all hooks that ran (used for SessionStart context). */
  output: string;
}

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one hook command, feeding the payload JSON on stdin. Never throws. */
function execHook(
  action: HookAction,
  payloadJson: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  return new Promise((resolvePromise) => {
    // POSIX-only: `/bin/bash` is hardcoded, so on Windows (and on a distro
    // without bash at that path) `spawn` emits 'error' and every hook resolves
    // with code 1 — which, for PreToolUse, blocks the tool it guards.
    const child = spawn("/bin/bash", ["-c", action.command], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Drop the abort listener explicitly: the gate runs this once per tool
      // call against ONE long-lived turn signal, so leaving them attached
      // accumulates a listener (and a reference to a dead child) per call.
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    /** Append `chunk` to `current`, stopping at {@link MAX_HOOK_STREAM_BYTES}. */
    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= MAX_HOOK_STREAM_BYTES) return current;
      const room = MAX_HOOK_STREAM_BYTES - current.length;
      if (chunk.length <= room) return current + chunk;
      return `${current}${chunk.slice(0, room)}\n[hook output truncated at ${MAX_HOOK_STREAM_BYTES} bytes]`;
    };

    const timeoutMs = Math.min(
      action.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      600_000,
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: 124,
        stdout,
        stderr: stderr + `\n[hook timed out after ${timeoutMs}ms]`,
      });
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ code: 130, stdout, stderr: stderr + "\n[hook aborted]" });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (d: Buffer) => {
      stdout = appendCapped(stdout, d.toString());
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = appendCapped(stderr, d.toString());
    });
    child.on("error", (err) =>
      finish({ code: 1, stdout, stderr: stderr + String(err) }),
    );
    child.on("close", (code) => finish({ code: code ?? 0, stdout, stderr }));

    // A hook that exits before reading stdin makes the write below emit EPIPE
    // asynchronously on the stdin stream. Swallow it — the exit code is what
    // matters, and an unhandled stream error would otherwise crash the process.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(payloadJson);
      child.stdin.end();
    } catch {
      /* stdin may already be closed if the command exits immediately */
    }
  });
}

/** Which matchers apply for this event + tool. SessionStart ignores the matcher. */
function selectMatchers(
  event: HookEvent,
  matchers: HookMatcher[],
  toolName: string | undefined,
): HookMatcher[] {
  if (event === "SessionStart") return matchers;
  if (!toolName) return [];
  return matchers.filter((m) => matchGlob(m.matcher ?? "*", toolName));
}

/**
 * Run all hooks registered for an event. Returns whether the action should be
 * blocked (PreToolUse) and any captured stdout (SessionStart context).
 */
export async function runHooks(
  hooks: Hooks | undefined,
  payload: HookPayload,
  signal?: AbortSignal,
): Promise<HookRunOutcome> {
  const none: HookRunOutcome = { blocked: false, output: "" };
  if (!hooks) return none;
  const matchers = hooks[payload.event];
  if (!matchers || matchers.length === 0) return none;

  const selected = selectMatchers(payload.event, matchers, payload.tool?.name);
  if (selected.length === 0) return none;

  const payloadJson = JSON.stringify(payload);
  const outputs: string[] = [];

  for (const matcher of selected) {
    for (const action of matcher.hooks) {
      const result = await execHook(action, payloadJson, payload.cwd, signal);
      if (result.stdout.trim()) outputs.push(result.stdout.trim());

      // PreToolUse is the only blocking event: a non-zero exit vetoes the tool.
      if (payload.event === "PreToolUse" && result.code !== 0) {
        const reason =
          result.stderr.trim() ||
          result.stdout.trim() ||
          `hook \`${action.command}\` exited ${result.code}`;
        return { blocked: true, reason, output: outputs.join("\n") };
      }
    }
  }

  return { blocked: false, output: outputs.join("\n") };
}
