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
  effort?: "low" | "medium" | "high";
  onError?: (e: { error: unknown }) => void;
  onStepFinish?: (s: { toolCalls?: unknown[] }) => void;
}

/**
 * The streaming result the engine consumes (`textStream`, `steps`, `usage`,
 * `response`). Both a `streamText` wrapper (CLI/BYOK) and a `streamAgentReply`
 * wrapper (platform) satisfy this exactly — both return `StreamTextResult`.
 */
export type StreamRunResult = StreamTextResult<ToolSet, never>;

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
