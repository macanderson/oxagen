/**
 * Engine ports — the interfaces the agent engine depends on.
 *
 * The engine is dependency-light: it never imports platform packages and never
 * calls `streamText`/`generateObject` from `ai` directly in its loop/pipeline.
 * Instead each consumer injects implementations of these ports:
 *   - CLI: local filesystem, a BYOK (unmetered) AgentAi, local code-graph/memory/trace.
 *   - Platform: a Vercel Sandbox workspace, an AgentAi backed by `@oxagen/ai`
 *     (`streamAgentReply` — metered, credits, tenant scope), Neo4j code-graph,
 *     `agent.memory.*` memory, ClickHouse trace.
 *
 * See docs/adr/ADR-017-unified-agent-engine.md.
 */
import type { ModelMessage, ToolSet, StreamTextResult, stepCountIs } from "ai";
import type { ZodType } from "zod";

/** Arguments for one streaming model turn (mirrors the subset of `streamText` the loop uses). */
export interface ModelRunArgs {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  stopWhen: ReturnType<typeof stepCountIs>;
  abortSignal?: AbortSignal;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  onError?: (e: { error: unknown }) => void;
  onStepFinish?: (s: {
    toolCalls?: unknown[];
    toolResults?: unknown[];
  }) => void;
}

/**
 * The streaming result the engine consumes (`textStream`, `steps`, `usage`,
 * `response`). Both a `streamText` wrapper (CLI/BYOK) and a `streamAgentReply`
 * wrapper (platform) satisfy this exactly — both return `StreamTextResult`.
 */
export type StreamRunResult = StreamTextResult<
  ToolSet,
  Record<string, unknown>,
  never
>;

/** Arguments for one structured-output generation (mirrors `generateObject`). */
export interface ObjectRunArgs<T> {
  model: string;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  schema: ZodType<T>;
  abortSignal?: AbortSignal;
}

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Prompt tokens served from the provider's cache — a SUBSET of
   * `inputTokens`, not additional to it. The AI SDK reports this nested as
   * `usage.inputTokenDetails.cacheReadTokens` on the raw `generateObject`
   * result; adapters flatten it to this field here (mirrors
   * `StreamRunResult`'s usage, which the engine step loop flattens the same
   * way — see engine.ts).
   */
  cachedInputTokens?: number;
}

export interface ObjectRunResult<T> {
  object: T;
  usage: UsageTokens;
}

/**
 * The injected AI port. The single seam that lets the engine meter correctly on
 * the platform (backed by `@oxagen/ai`) and stay BYOK/unmetered in the CLI.
 */
export interface AgentAi {
  stream(args: ModelRunArgs): StreamRunResult;
  generateObject<T>(args: ObjectRunArgs<T>): Promise<ObjectRunResult<T>>;
}

/** Episodic/recalled memory. CLI: local DuckDB/engram. Platform: `agent.memory.*`. */
export interface MemoryProvider {
  recallContext(): Promise<string>;
  remember(
    kind: string,
    content: unknown,
    status?: string,
  ): void | Promise<void>;
  close?(): Promise<void>;
}

/** Per-turn trace sink. CLI: local JSON files. Platform: ClickHouse. */
export interface TraceStore {
  // TurnTrace is defined in src/trace/types.ts; using `unknown` here keeps
  // this file dep-light and avoids a circular import through the ports layer.
  record(trace: unknown): void | Promise<void>;
}

/**
 * Optional project-diagnostics provider (e.g. an incremental tsserver / LSP).
 * When wired, edit gating compares its before/after output on the edited file —
 * in addition to the engine's built-in single-file syntax check — and blocks a
 * write that would introduce NEW diagnostics (unless the edit declares the
 * breakage via `expect_errors`). The two sources are unioned: a diagnostic
 * reported by either the built-in check or this provider counts.
 *
 * No implementation ships in-engine — this is the SEAM, mirroring
 * {@link FileLockProvider}. CLI: unwired (undefined) — the built-in syntactic
 * check is the only gate, single-process with no project server. Platform: MAY
 * inject a tsserver/LSP-backed adapter so the gate also catches cross-file type
 * breakage the single-file syntactic check cannot see. A provider failure MUST
 * degrade to the built-in check alone (fail-open on the optional source) — a
 * broken diagnostics server never wedges an edit.
 */
export interface DiagnosticsProvider {
  diagnostics(path: string, content: string): Promise<{ errors: string[] }>;
}

/** Result of a single acquire attempt (mirrors the Postgres lease service's `AcquiredLease`). */
export interface FileLockGrant {
  granted: boolean;
  lockId: string;
  /** The conflicting holder's agentId, when `granted` is false. */
  heldBy: string | null;
  /** Epoch-ms the conflicting lock expires at, when `granted` is false. */
  blockedUntil: number | null;
  /**
   * Monotonic per-resource fencing token for a granted lease (ADR-021 §5) — a
   * takeover after expiry always issues a strictly higher token, so a caller
   * that carries the token can be rejected at write time if a newer holder took
   * over. Optional/null for providers that don't fence (the legacy Neo4j
   * adapter) or a denied grant.
   */
  fencingToken?: number | null;
}

/**
 * File-lock port: a tenant-scoped, cross-process exclusive lock on a file
 * (docs/specs/agent-file-locking/plan.md) so two live agents — whether both
 * are CLI/chat/fleet turns or subagent-fanout children — never clobber the
 * same file. This is the SINGLE wiring point: `write_file`/`edit_file` in
 * `tools.ts` acquire immediately before the real filesystem write and release
 * immediately after, regardless of which surface (chat, CLI, `agent.repo.edit`
 * fleet dispatch) called `runCodingAgent` — there is exactly one enforcement
 * point, not one per caller.
 *
 * CLI: no `fileLock` is injected (undefined) — the CLI runs single-process, so
 * locking is a no-op there by omission. Platform: injects the transactional
 * Postgres lease adapter from `@oxagen/agent/adapters`.
 */
export interface FileLockProvider {
  /**
   * Acquire (or, for the SAME `agentId`, renew) an exclusive lock on `path`.
   * Never throws — a lease-store failure here degrades to "not granted" so a
   * transient database outage fails a single tool call, not the whole turn; the
   * caller decides whether to retry, deny, or (when uninjected) proceed
   * unlocked.
   */
  acquire(args: {
    path: string;
    agentId: string;
    executionId: string;
    action?: string;
  }): Promise<FileLockGrant>;
  /** Release a single lock right after the write that acquired it (success or failure). */
  release(args: { lockId: string; agentId: string }): void | Promise<void>;
  /**
   * Batch-release every lock this execution/turn holds — the turn-end
   * backstop so a crashed/aborted turn
   * never leaks a lock past its own lifetime even if a per-call release was
   * skipped.
   */
  releaseAll(executionId: string): void | Promise<void>;
}
