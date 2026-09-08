/**
 * What the collector knows about the host and the enrollment, supplied to
 * every normalizer. Pure data; the collector fills it in once per session.
 */
import { createHash } from "node:crypto";
import type { TachoEvent } from "../envelope";

export type AgentIdentity = TachoEvent["agent"];
export type HostFacts = NonNullable<TachoEvent["host"]>;

export interface ClaudeCodeContext {
  agent: AgentIdentity;
  /** Host facts the collector observed (digests already applied). */
  host?: HostFacts;
  /** Environment names matching this pattern are never recorded. */
  secretEnvPattern?: RegExp;
  /** Clock for `ts` when the source carries none (hooks). */
  now?: () => number;
}

export const DEFAULT_SECRET_ENV_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i;

export function digestText(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Keep only the harness-relevant, non-secret environment members. */
export function snapshotEnv(
  env: Record<string, string | undefined>,
  secretPattern: RegExp = DEFAULT_SECRET_ENV_PATTERN,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (
      !/^(CLAUDE|OTEL|ANTHROPIC|TERM_PROGRAM$|SHELL$|CI$|GITHUB_ACTIONS$)/.test(
        key,
      )
    ) {
      continue;
    }
    if (secretPattern.test(key)) {
      continue;
    }
    out[key] = value.length > 1024 ? `${value.slice(0, 1024)}...` : value;
  }
  return out;
}

/** Host facts derivable from the hook process environment alone. */
export function hostFactsFromEnv(
  env: Record<string, string | undefined>,
): Partial<HostFacts> {
  const facts: Partial<HostFacts> = {};
  const pid = env["CLAUDE_PID"];
  if (pid !== undefined && /^\d+$/.test(pid)) {
    facts.claude_pid = Number(pid);
  }
  if (env["CLAUDE_CODE_EXECPATH"] !== undefined) {
    facts.claude_execpath = env["CLAUDE_CODE_EXECPATH"];
  }
  if (env["CLAUDE_CODE_CHILD_SESSION"] !== undefined) {
    facts.is_child_session = env["CLAUDE_CODE_CHILD_SESSION"] === "1";
  }
  if (env["CLAUDE_CODE_BRIDGE_SESSION_ID"] !== undefined) {
    facts.bridge_session_id = env["CLAUDE_CODE_BRIDGE_SESSION_ID"];
  }
  return facts;
}

/** Context facts derivable from the hook process environment alone. */
export function contextFactsFromEnv(
  env: Record<string, string | undefined>,
): Partial<NonNullable<TachoEvent["context"]>> {
  const facts: Partial<NonNullable<TachoEvent["context"]>> = {};
  if (env["CLAUDE_CODE_ENTRYPOINT"] !== undefined) {
    facts.entrypoint = env["CLAUDE_CODE_ENTRYPOINT"];
  }
  if (env["CLAUDE_EFFORT"] !== undefined) {
    facts.effort = env["CLAUDE_EFFORT"];
  }
  if (env["CLAUDE_PROJECT_DIR"] !== undefined) {
    facts.project_dir = env["CLAUDE_PROJECT_DIR"];
  }
  if (env["TERM_PROGRAM"] !== undefined) {
    facts.terminal_type = env["TERM_PROGRAM"];
  }
  return facts;
}

/** Version from `.../claude/versions/2.1.263`, when the exec path carries one. */
export function harnessVersionFromExecPath(
  execPath: string | undefined,
): string | undefined {
  if (execPath === undefined) {
    return undefined;
  }
  const match = /\/versions\/(\d+\.\d+\.\d+)(?:\/|$)/.exec(execPath);
  return match?.[1];
}
