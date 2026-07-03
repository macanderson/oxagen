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
  onStepFinish?: (s: { toolCalls?: unknown[]; toolResults?: unknown[] }) => void;
}

/**
 * The streaming result the engine consumes (`textStream`, `steps`, `usage`,
 * `response`). Both a `streamText` wrapper (CLI/BYOK) and a `streamAgentReply`
 * wrapper (platform) satisfy this exactly — both return `StreamTextResult`.
 */
export type StreamRunResult = StreamTextResult<ToolSet, Record<string, unknown>, never>;

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
  remember(kind: string, content: unknown, status?: string): void | Promise<void>;
  close?(): Promise<void>;
}

/** Per-turn trace sink. CLI: local JSON files. Platform: ClickHouse. */
export interface TraceStore {
  // TurnTrace is defined in src/trace/types.ts; using `unknown` here keeps
  // this file dep-light and avoids a circular import through the ports layer.
  record(trace: unknown): void | Promise<void>;
}

/**
 * Graph-sync port: materialises touched files into the knowledge graph and
 * records execution-lineage edges from the turn's execution node to each file.
 *
 * Both methods are fire-and-forget — callers MUST wrap them in
 * `void Promise.resolve(...).catch(() => {})` so a failure never blocks or
 * fails the agent turn.
 *
 * CLI: a no-op stub (the CLI has no platform Neo4j session).
 * Platform: injects the in-app adapter from `@oxagen/agent/adapters`.
 */
export interface GraphSyncProvider {
  /**
   * Upsert minimal `:SourceFile` nodes for every path in `touchedFiles`.
   * Called near the start of turn finalization so the nodes exist before
   * `recordLineage` attempts to create TOUCHED_FILE edges.
   */
  ensureGraph(touchedFiles: string[]): void | Promise<void>;

  /**
   * Create `(:Execution)-[:TOUCHED_FILE]->(:SourceFile)` edges in Neo4j for
   * every path in `touchedFiles`. Uses the turn's trace id as the executionId.
   */
  recordLineage(args: { executionId: string; touchedFiles: string[] }): void | Promise<void>;
}
