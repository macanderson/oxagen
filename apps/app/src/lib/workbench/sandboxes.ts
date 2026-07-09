/**
 * workbench/sandboxes.ts — server-side wrappers over the durable-sandbox
 * capabilities (`agent.sandbox.*`).
 *
 * The Workbench → Sandboxes surface lets a human list a workspace's durable
 * sandbox sessions, warm a new one (`start_sandbox` + a one-time setupCmd),
 * drive a terminal against it (`run_sandbox_command`), inspect its files
 * (`agent.sandbox_file.*`, via the WorkspaceContextPanel's own API fetch), and
 * stop it. These contracts declare surfaces ["api","mcp","agent"] — NOT "app" —
 * so we invoke with the `{ surface: "agent" }` call-option, exactly like the
 * environment and secret server actions. The kernel still scopes every call to
 * org+workspace from ctx; apps/app supplies the IAM gate at the action layer.
 *
 * Server-only. Never import from a "use client" module.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import type { WorkbenchCtx } from "./scope";
import type { SandboxImage } from "@/components/sandbox/warm-up-templates";

export type SandboxStatus = "running" | "idle" | "stopped" | "gone";

export interface SandboxSummary {
  sessionId: string;
  sessionKey: string | null;
  image: SandboxImage;
  status: SandboxStatus;
  driver: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
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
  opts: { status?: SandboxStatus; limit?: number } = {},
): Promise<SandboxSummary[]> {
  const out = (await invoke("list_sandboxes", opts, ctx, {
    surface: "agent",
  })) as { sandboxes: SandboxSummary[] };
  return out.sandboxes;
}

export async function startSandbox(
  ctx: WorkbenchCtx,
  input: {
    image?: SandboxImage;
    sessionKey?: string;
    setupCmd?: string;
    network?: "allow" | "deny";
  },
): Promise<SandboxStartResult> {
  return (await invoke("start_sandbox", input, ctx, {
    surface: "agent",
  })) as SandboxStartResult;
}

export async function runSandboxCommand(
  ctx: WorkbenchCtx,
  input: { sessionId: string; command: string; timeoutMs?: number },
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
