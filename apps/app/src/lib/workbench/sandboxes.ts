/**
 * workbench/sandboxes.ts — server-side wrappers over the durable-sandbox
 * capabilities (`agent.sandbox.*`).
 *
 * The Workbench → Sandboxes surface lets a human list a workspace's durable
 * sandbox sessions (optionally `activeOnly` for a live-reconciled, truthful
 * view), warm a new one (`start_sandbox` + a one-time setupCmd and/or repos to
 * clone), drive a terminal against it (`run_sandbox_command`), inspect its
 * files (`agent.sandbox_file.*`, via the WorkspaceContextPanel's own API
 * fetch), rename it (`rename_sandbox`), and stop it. These contracts declare
 * surfaces ["api","mcp","agent"] — NOT "app" — so we invoke with the
 * `{ surface: "agent" }` call-option, exactly like the environment and secret
 * server actions. The kernel still scopes every call to org+workspace from
 * ctx; apps/app supplies the IAM gate at the action layer.
 *
 * Server-only. Never import from a "use client" module.
 */
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import type { WorkbenchCtx } from "./scope";
import type { SandboxImage } from "@/components/sandbox/warm-up-templates";

export type SandboxStatus = "running" | "idle" | "stopped" | "gone";

export interface SandboxSummary {
  sessionId: string;
  sessionKey: string | null;
  /** Human-friendly name given when the sandbox was warmed, or null when unnamed. */
  label: string | null;
  image: SandboxImage;
  status: SandboxStatus;
  driver: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /**
   * Session-lifecycle recovery + reap metadata. `list_sandboxes` grows these
   * fields as the sibling capability change lands; until then they are absent
   * at runtime, so every one is optional and the UI degrades gracefully.
   */
  /** "pending" | "recovered" | "failed" | undefined — recovery-flush state. */
  recoveryStatus?: string;
  /** Branch the sandbox's work was flushed to on recovery. */
  recoveryBranch?: string | null;
  /** Commit sha of the recovery flush, when available. */
  recoveryCommit?: string | null;
  /** ISO deadline: when an idle session is reaped unless it is reused first. */
  graceDeadlineAt?: string | null;
  /** True when the working tree has uncommitted changes. */
  dirty?: boolean | null;
  /** ISO time the working tree was last flushed to durable storage. */
  flushedAt?: string | null;
  /** ISO time the session's work was recovered to a branch. */
  recoveredAt?: string | null;
  /**
   * Repos cloned into `/work/<repo>` at warm time, when any were
   * requested. Absent until the sibling repo-aware warm-flow change starts
   * returning it — the UI treats a missing/empty array as "no repos".
   */
  repos?: Array<{ owner: string; repo: string; branch?: string }>;
}

/** A repo to clone into a sandbox at create time — `POST start_sandbox` input shape. */
export interface SandboxRepoRef {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * One captured output line from a durable sandbox session — the exact shape the
 * `list_sandbox_logs` capability returns. The text field is `line` and the
 * timestamp is `ts`; keep this in lockstep with the contract's output, since a
 * mismatched field name renders every log row blank rather than failing loudly.
 */
export interface SandboxLogLine {
  /** ISO timestamp of the line. */
  ts: string;
  /** Which pipe the line came from; `system` is a lifecycle/echo/timing note. */
  stream: "stdout" | "stderr" | "system";
  /** Verbosity bucket — `debug` covers command echoes and lifecycle plumbing. */
  level: "normal" | "debug";
  /** The command this line belongs to (empty for lifecycle notes). */
  command: string;
  /** Monotonic ordering key within the session. */
  seq: number;
  /** The captured output text. */
  line: string;
  /** Exit code, on the `system` line that closes a command; null otherwise. */
  exitCode: number | null;
  /** Wall-clock duration in ms, on that same `system` line; null otherwise. */
  durationMs: number | null;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionMs: number;
  timedOut: boolean;
  restored: boolean;
}

export interface SandboxStartResult {
  sessionId: string;
  status: string;
  image: SandboxImage;
  createdAt: string;
  reused: boolean;
}

/**
 * Durable sessions require SANDBOX_ENABLED + a session-capable driver (Modal).
 * When absent the handler throws `DurableSandboxUnavailableError`; detect it by
 * message so the UI can render a helpful "not configured" state rather than a
 * generic crash.
 */
export function isSandboxUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /durable sandbox|SANDBOX_ENABLED|not available/i.test(msg);
}

export async function listSandboxes(
  ctx: WorkbenchCtx,
  opts: {
    status?: SandboxStatus;
    limit?: number;
    /**
     * When true, restrict to running|idle sessions AND live-reconcile each
     * against the provider so a session the driver already tore down is
     * excluded/corrected rather than trusted at its last-known Postgres
     * status. The list UI defaults to this so a stopped/reaped sandbox never
     * reads as "running".
     */
    activeOnly?: boolean;
  } = {},
): Promise<SandboxSummary[]> {
  const out = (await invoke("list_sandboxes", opts, ctx, {
    surface: "agent",
  })) as { sandboxes: SandboxSummary[] };
  // The capability shapes each summary; the extended recovery/reap fields flow
  // straight through this cast and are simply absent until the sibling change
  // starts returning them.
  return out.sandboxes ?? [];
}

/**
 * Read the captured output log for a session. `level: "normal"` returns program
 * output only; omitting `level` (the debug view) returns everything, including
 * command echoes and timing/lifecycle notes.
 */
export async function listSandboxLogs(
  ctx: WorkbenchCtx,
  input: { sessionId: string; level?: "normal" | "debug"; limit?: number },
): Promise<SandboxLogLine[]> {
  const out = (await invoke("list_sandbox_logs", input, ctx, {
    surface: "agent",
  })) as { lines?: SandboxLogLine[] };
  return out.lines ?? [];
}

export async function startSandbox(
  ctx: WorkbenchCtx,
  input: {
    image?: SandboxImage;
    sessionKey?: string;
    /** Human-friendly name persisted on the session and shown in the list. */
    label?: string;
    setupCmd?: string;
    network?: "allow" | "deny";
    /**
     * Warm from a saved sandbox template (sbx_…) instead of a bare image — the
     * template's provider/runtime/resources/network + vault secret selection are
     * frozen onto the session.
     */
    sandboxTemplateId?: string;
    /** Workspace environment (env_…) whose vault secrets bind to the session. */
    environmentId?: string;
    /**
     * Repos to clone into `/work/<repo>` during provisioning (max 8,
     * enforced by the action's zod schema). Each entry's `branch` defaults to
     * the repo's default branch server-side when omitted.
     */
    repos?: SandboxRepoRef[];
  },
): Promise<SandboxStartResult> {
  return (await invoke("start_sandbox", input, ctx, {
    surface: "agent",
  })) as SandboxStartResult;
}

/** Result of `rename_sandbox` — the session's new persisted label. */
export interface SandboxRenameResult {
  sessionId: string;
  label: string;
}

/** Rename a sandbox session's human-friendly label (the list's primary identifier). */
export async function renameSandbox(
  ctx: WorkbenchCtx,
  input: { sessionId: string; label: string },
): Promise<SandboxRenameResult> {
  return (await invoke("rename_sandbox", input, ctx, {
    surface: "agent",
  })) as SandboxRenameResult;
}

export async function runSandboxCommand(
  ctx: WorkbenchCtx,
  input: {
    sessionId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<SandboxExecResult> {
  return (await invoke("run_sandbox_command", input, ctx, {
    surface: "agent",
  })) as SandboxExecResult;
}

export async function stopSandbox(
  ctx: WorkbenchCtx,
  sessionId: string,
): Promise<{ stopped: boolean }> {
  return (await invoke("stop_sandbox", { sessionId }, ctx, {
    surface: "agent",
  })) as { stopped: boolean };
}
