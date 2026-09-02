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
  /**
   * RAM ceiling in MiB. Enforced by docker (`HostConfig.Memory`) and modal
   * (`memory_mb` on the runner). The vercel driver has no independent memory
   * knob — @vercel/sandbox derives RAM from vCPU count — so this field is
   * ignored there.
   */
  memoryMb: number;
  network: "allow" | "deny";
  /**
   * Custom container image from a sandbox template's `runtime`. Overrides the
   * language default image in `images.ts`. Only drivers that can pull an
   * arbitrary image honor it: docker (used as the image string) and modal
   * (passed to the runner's `image` param). The vercel driver has a fixed
   * runtime set and throws a clear error when it is set — no silent fallback
   * to the default image.
   *
   * The value is a workspace-admin-supplied template field, NOT model input,
   * and it is NOT validated to be digest-pinned: a mutable tag here opts that
   * template out of the pinning guarantee `images.ts` provides for the
   * built-in images.
   */
  imageRef?: string;
  /**
   * vCPU count from a template's resources. Docker maps it to NanoCpus and
   * vercel to `resources.vcpus`; a driver that cannot set it ignores the field.
   * Unset = the driver's default.
   */
  vcpu?: number;
  /**
   * Ephemeral workspace disk in MiB from a template's resources. Docker maps it
   * to the `/work` tmpfs size; drivers without a disk knob ignore it.
   */
  diskMb?: number;
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
  /**
   * Custom container image (digest-pinned ref) from a sandbox template's
   * `runtime`, overriding the `image` kind's default. Passed to the durable
   * runner as `image_ref`; a runner that predates the field maps `image`
   * instead. Only session-capable drivers (Modal) provision durable sessions,
   * so this is honored only there.
   */
  imageRef?: string;
  memoryMb: number;
  /** vCPU count from a template's resources (driver default when unset). */
  vcpu?: number;
  /** Ephemeral workspace disk in MiB from a template's resources. */
  diskMb?: number;
  /** Hard ceiling on total session lifetime, seconds (Modal caps at 24h). */
  ttlSeconds: number;
  /** Reap after this many seconds of inactivity — the primary cost lever. */
  idleTimeoutSeconds: number;
  network: "allow" | "deny";
  orgId: string;
  workspaceId: string;
  /** One-shot command run once at create time (e.g. clone a repo / install). */
  setupCmd?: string;
  /**
   * Env injected into the `setupCmd` exec ONLY (not persisted in the image).
   * TRUSTED values resolved server-side (environment vault secrets + template
   * literal_env) — the credential channel that lets a setup command clone a
   * private repo. May contain secrets: never log values.
   */
  setupEnv?: Record<string, string>;
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
  /**
   * Working directory to run the command in. A fresh `sh -c` per exec resets
   * cwd to the image default every call, so a stateful caller (the durable
   * terminal) threads the prior `cwd` here and reads the resulting one back out
   * of {@link SandboxExecResult.cwd}. Undefined → the image default.
   */
  cwd?: string;
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
  /**
   * The shell's working directory AFTER the command ran. Undefined when the
   * runner couldn't report it (a runner deployed before cwd support, the
   * command self-`exit`ed, or it timed out) — the caller keeps its prior cwd.
   */
  cwd?: string;
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
