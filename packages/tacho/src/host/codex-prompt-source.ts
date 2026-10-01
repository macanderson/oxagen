/**
 * Who sent a Codex prompt, written in the values Claude Code uses, so the
 * unproductive spend detectors can tell a person from a scheduler or another
 * agent (detectors 6 and 7).
 *
 * Claude Code records the sender on each transcript `user` record:
 * `promptSource` (`typed`, `queued`, `system`, `sdk`) and `origin`
 * (`{"kind": "human"}`, `task-notification`, `peer`, `coordinator`,
 * `auto-continuation`). Codex records no such field on a prompt. Three things
 * it does record say who sent one (verified 2026-10-01 against openai/codex
 * main, `codex-rs/hooks/schema/generated` and `codex-rs/core/src/
 * hook_runtime.rs`, and against Codex 0.155 to 0.159 rollouts):
 *
 * - The `UserPromptSubmit` payload carries `agent_id` and `agent_type` only
 *   for a prompt a parent agent sent to a subagent it spawned.
 * - A Codex Desktop heartbeat automation sends its prompt as a
 *   `<heartbeat>` document that names the automation in `<automation_id>`.
 * - The first line of the rollout at `transcript_path` is the thread's
 *   `session_meta`. Its `source` names the surface that started the thread
 *   (`cli`, `vscode`, `exec`, `mcp`, or a subagent object), and its
 *   `thread_source` says whether a person started it (`user`).
 *
 * `codexPromptSource` maps those to Claude Code's values. Anything else
 * leaves both fields absent, which every reader takes as null: absent, never
 * a guess.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** The two prompt facts, as the `turn_start` body carries them. */
export interface PromptSourceFacts {
  prompt_source: string;
  prompt_origin?: { kind: string };
}

/** The members of a rollout's `session_meta` line the mapping reads. */
export interface CodexSessionMeta {
  /** `cli`, `vscode`, `exec`, `mcp`, or an object for a subagent. */
  source?: unknown;
  /** `user` for a thread a person started. Older rollouts omit it. */
  thread_source?: unknown;
}

/** A person typed the prompt: Claude Code's `typed` with a `human` origin. */
const TYPED: PromptSourceFacts = {
  prompt_source: "typed",
  prompt_origin: { kind: "human" },
};

/**
 * A parent agent sent the prompt to the subagent it spawned. Claude Code
 * marks the prompt a coordinator sends a subagent with this origin.
 */
const FROM_AGENT: PromptSourceFacts = {
  prompt_source: "system",
  prompt_origin: { kind: "coordinator" },
};

/**
 * A Codex automation sent the prompt on a schedule. Claude Code records no
 * scheduler origin, so `heartbeat` is Codex's own name for it.
 */
const FROM_HEARTBEAT: PromptSourceFacts = {
  prompt_source: "system",
  prompt_origin: { kind: "heartbeat" },
};

/** A program started the thread: `codex exec`, or Codex as an MCP server. */
const FROM_PROGRAM: PromptSourceFacts = { prompt_source: "sdk" };

/** The surfaces where a person types into the thread. */
const INTERACTIVE_SOURCES: ReadonlySet<string> = new Set(["cli", "vscode"]);

/** The surfaces a program drives. */
const PROGRAM_SOURCES: ReadonlySet<string> = new Set(["exec", "mcp"]);

/**
 * Whether a prompt is a heartbeat automation's: a `<heartbeat>` document
 * that names its automation.
 */
export function isCodexHeartbeat(prompt: string): boolean {
  return (
    prompt.trimStart().startsWith("<heartbeat>") &&
    prompt.includes("<automation_id>")
  );
}

/**
 * Who sent a Codex prompt, from its hook payload and its thread's
 * `session_meta`, or undefined when neither says. The payload's own signals
 * come first, because they describe this one prompt. The thread's source
 * describes every prompt in it, and is read only when the payload says
 * nothing.
 *
 * A thread whose `source` is `cli` or `vscode` with no `thread_source` comes
 * from a Codex older than the field, and a subagent thread with no
 * `agent_id` in the payload is one Codex runs itself (a guardian review).
 * Neither says who sent the prompt, so both stay absent.
 */
export function codexPromptSource(
  payload: Readonly<Record<string, unknown>>,
  meta: CodexSessionMeta | undefined,
): PromptSourceFacts | undefined {
  const agentId = payload["agent_id"];
  if (typeof agentId === "string" && agentId.length > 0) return FROM_AGENT;
  const prompt = payload["prompt"];
  if (typeof prompt === "string" && isCodexHeartbeat(prompt))
    return FROM_HEARTBEAT;
  if (meta === undefined || typeof meta.source !== "string") return undefined;
  if (PROGRAM_SOURCES.has(meta.source)) return FROM_PROGRAM;
  if (INTERACTIVE_SOURCES.has(meta.source) && meta.thread_source === "user")
    return TYPED;
  return undefined;
}

/**
 * The most of a rollout the hook reads to find its first line. The
 * `session_meta` line carries the thread's base instructions, and the
 * longest in 259 local rollouts ran to 23 KiB.
 */
export const CODEX_SESSION_META_MAX_BYTES = 256 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The first line of a file, read in chunks up to `maxBytes`, or undefined
 * when the file cannot be read or its first line runs past the bound.
 */
export function readFirstLine(
  path: string,
  maxBytes = CODEX_SESSION_META_MAX_BYTES,
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes - total));
      const read = readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const end = chunk.subarray(0, read).indexOf(0x0a);
      if (end !== -1) {
        chunks.push(chunk.subarray(0, end));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    // A file with no line break holds one line, unless the bound cut it.
    return total < maxBytes
      ? Buffer.concat(chunks).toString("utf8")
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read is done; a failed close leaks nothing the hook keeps.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `session_meta` at the head of a Codex rollout, or undefined when the
 * file is missing, empty, or opens with another record. Codex writes the
 * line before it hands a hook the path (`hook_transcript_path` materializes
 * the rollout first).
 */
export function readCodexSessionMeta(
  path: string,
  readLine: (path: string) => string | undefined = readFirstLine,
): CodexSessionMeta | undefined {
  const line = readLine(path);
  if (line === undefined || line.trim().length === 0) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || record["type"] !== "session_meta") return undefined;
  const payload = record["payload"];
  if (!isRecord(payload)) return undefined;
  return { source: payload["source"], thread_source: payload["thread_source"] };
}

/**
 * A Codex `UserPromptSubmit` payload with `prompt_source` and
 * `prompt_origin` set from `codexPromptSource`, which the hook normalizer
 * copies onto the `turn_start` frame. Every other payload, and one that
 * already names its source, is returned as it is. The rollout is read only
 * when the payload alone does not say who sent the prompt.
 */
export function withCodexPromptSource(
  raw: unknown,
  readMeta: (path: string) => CodexSessionMeta | undefined = (path) =>
    readCodexSessionMeta(path),
): unknown {
  if (!isRecord(raw) || raw["hook_event_name"] !== "UserPromptSubmit")
    return raw;
  if (raw["prompt_source"] !== undefined || raw["prompt_origin"] !== undefined)
    return raw;
  const path = raw["transcript_path"];
  const facts =
    codexPromptSource(raw, undefined) ??
    (typeof path === "string" && path.length > 0
      ? codexPromptSource(raw, readMeta(path))
      : undefined);
  if (facts === undefined) return raw;
  return {
    ...raw,
    prompt_source: facts.prompt_source,
    ...(facts.prompt_origin !== undefined
      ? { prompt_origin: { ...facts.prompt_origin } }
      : {}),
  };
}
