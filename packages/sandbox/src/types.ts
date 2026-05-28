export type SandboxLanguage = "node" | "python" | "shell";

export interface SandboxRequest {
  language: SandboxLanguage;
  code: string;
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  memoryMb: number;
  network: "allow" | "deny";
  tenantId: string;
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
}
