export type SandboxLanguage = "node" | "python" | "shell";

export interface SandboxRequest {
  language: SandboxLanguage;
  code: string;
  stdin?: string;
  env?: Record<string, string>;
  /**
   * Extra files to land into the workspace (relative path → contents) BEFORE
   * the entrypoint runs, so an agent can stage a multi-file edit and execute
   * against it. Paths are workspace-relative and must already be confined to
   * the root (validated upstream via `@oxagen/sandbox/workspace`). Each driver
   * writes them alongside the entrypoint code file so language-relative imports
   * (`require('./util')`, `import util`) resolve.
   */
  files?: Record<string, string>;
  timeoutMs: number;
  memoryMb: number;
  network: "allow" | "deny";
  orgId: string;
  workspaceId: string;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  oomKilled: boolean;
}

export interface SandboxStreamChunk {
  channel: "stdout" | "stderr";
  data: string;
  at: number;
}

// ── Durable sessions ─────────────────────────────────────────────────────────
// A *durable* sandbox is a long-lived container that survives between agent
// turns: the agent creates it once, then reconnects to the SAME filesystem and
// running processes (cloned repo, installed deps, dev server) across many
// separate `agent.sandbox.exec` calls. Only drivers whose backend can keep a
// container warm across HTTP requests (Modal) implement these; the rest leave
// `supportsSessions` falsy and the `agent.sandbox.*` handlers fail closed.

/** Base image flavor for a durable session (git is pre-installed in all). */
export type SandboxImageKind = "node" | "python" | "shell" | "agent";

export interface SandboxSessionSpec {
  image: SandboxImageKind;
  memoryMb: number;
  /** Hard ceiling on total session lifetime, seconds (Modal caps at 24h). */
  ttlSeconds: number;
  /** Reap after this many seconds of inactivity — the primary cost lever. */
  idleTimeoutSeconds: number;
  network: "allow" | "deny";
  orgId: string;
  workspaceId: string;
  /** One-shot command run once at create time (e.g. clone a repo / install). */
  setupCmd?: string;
}

export interface SandboxSessionHandle {
  /** The driver's live sandbox id (e.g. Modal `sb-…`). Changes on restore. */
  sandboxId: string;
  status: "running";
  /** ISO-8601 creation timestamp reported by the runner. */
  createdAt: string;
}

export interface SandboxExecRequest {
  sandboxId: string;
  /** Shell command line; run via `sh -c` inside the durable workspace. */
  command: string;
  timeoutMs: number;
  env?: Record<string, string>;
  stdin?: string;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * True when the underlying sandbox was reaped/terminated (idle timeout, TTL,
   * OOM) and could not be reconnected. The caller restores from the last
   * filesystem snapshot and retries.
   */
  gone: boolean;
}

export interface SandboxDriver {
  /** Capability handler entry. Resolves when the container exits or is killed. */
  run(req: SandboxRequest): Promise<SandboxResult>;
  /** Streaming variant — yields chunks as the container produces them. */
  stream(req: SandboxRequest): AsyncIterable<SandboxStreamChunk>;
  /** Best-effort pool warmup; safe to no-op. */
  warmup?(): Promise<void>;
  /** Shutdown hook; tear down pool, drain in-flight, close socket. */
  shutdown?(): Promise<void>;
  /** Driver name surfaced in observability. */
  readonly name: string;

  // ── Durable-session lifecycle (optional capability) ────────────────────────
  // Present only on drivers that can hold a container warm between turns. The
  // `agent.sandbox.*` handlers gate on `supportsSessions` and throw a clear
  // error when the active driver can't.
  readonly supportsSessions?: boolean;
  createSession?(spec: SandboxSessionSpec): Promise<SandboxSessionHandle>;
  execInSession?(req: SandboxExecRequest): Promise<SandboxExecResult>;
  snapshotSession?(sandboxId: string): Promise<{ snapshotId: string }>;
  restoreSession?(
    snapshotId: string,
    spec: SandboxSessionSpec,
  ): Promise<SandboxSessionHandle>;
  stopSession?(sandboxId: string): Promise<void>;
  sessionStatus?(sandboxId: string): Promise<"running" | "gone">;
}

/**
 * A driver guaranteed to support durable sessions — every optional method is
 * non-null. `requireDurableDriver()` narrows a `SandboxDriver` to this after a
 * runtime capability check, so the `agent.sandbox.*` handlers can call the
 * session methods without `?.` noise.
 */
export interface DurableSandboxDriver extends SandboxDriver {
  readonly supportsSessions: true;
  createSession(spec: SandboxSessionSpec): Promise<SandboxSessionHandle>;
  execInSession(req: SandboxExecRequest): Promise<SandboxExecResult>;
  snapshotSession(sandboxId: string): Promise<{ snapshotId: string }>;
  restoreSession(
    snapshotId: string,
    spec: SandboxSessionSpec,
  ): Promise<SandboxSessionHandle>;
  stopSession(sandboxId: string): Promise<void>;
  sessionStatus(sandboxId: string): Promise<"running" | "gone">;
}

/** True when a driver implements the full durable-session surface. */
export function isDurableSandboxDriver(
  driver: SandboxDriver,
): driver is DurableSandboxDriver {
  return Boolean(
    driver.supportsSessions &&
      driver.createSession &&
      driver.execInSession &&
      driver.snapshotSession &&
      driver.restoreSession &&
      driver.stopSession &&
      driver.sessionStatus,
  );
}
