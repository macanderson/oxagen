import type { ModelMessage, ToolSet } from "ai";
import type { AgentAi, MemoryProvider, TraceStore } from "./ports";

// ── Model tiers + usage accounting ──────────────────────────────────────────
// Shared by router, trace types, evaluator, planner, and fleet.

/** Cost/capability tier. Maps to a concrete gateway model via the model router. */
export type ModelTier = "fast" | "balanced" | "precise";

/** Token + cost accounting for one call or the whole fleet. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Estimated provider cost in USD, from the vendored rate card. */
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Merge two UsageTotals additively. */
export function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

// ── Project context (injected by CLI; type lives here for engine portability) ─

/** Loaded project rules (CLAUDE.md / AGENTS.md / etc.), ready to inject. */
export interface ProjectContext {
  /** Concatenated rule text, ready to drop into the system prompt. */
  text: string;
  /** Source files that contributed, relative to cwd. */
  sources: string[];
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Workspace {
  root: string;
  readFile(p: string, opts?: { offset?: number; limit?: number }): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
  /**
   * Replace `oldString` with `newString`, returning the number of replacements.
   * Default (no opts): `oldString` must appear exactly once, else throws. With
   * `{ replaceAll: true }` every occurrence is replaced. A miss throws an Error
   * whose message is corrective feedback (see `describeEditFailure`).
   */
  editFile(
    p: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ): Promise<number>;
  list(dir?: string): Promise<string[]>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, opts?: { path?: string; glob?: string }): Promise<string[]>;
  exec(command: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
  diff(): Promise<string>;
}

export type CodingEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-call"; name: string; input: unknown }
  | {
      type: "tool-result";
      name: string;
      /** Tool input, JSON-stringified and capped. */
      input: string;
      /** Tool result, JSON-stringified and capped. */
      result: string;
      /** Wall-clock ms the step that ran this tool took (step-granular). */
      durationMs: number;
      /** False when the tool reported an error. */
      ok: boolean;
    }
  | { type: "file-edit"; path: string; bytes: number }
  | { type: "command"; command: string; exitCode: number }
  | { type: "final-diff"; diff: string; changedFiles: string[] };

export interface CodeGraphProvider {
  query(
    operation: "search" | "file_symbols" | "dependents" | "imports" | "semantic_search",
    query: string,
    limit?: number,
  ): Promise<string>;
}

/** Output shape for a single code.map result (mirrors contract output). */
export interface CodeMapBundle {
  files: Array<{
    nodeId: string;
    path: string;
    language: string;
    displayName: string;
    domain?: string;
    score: number;
  }>;
  symbols: Array<{
    nodeId: string;
    name: string;
    kind: string;
    path: string;
    startLine: number;
    endLine: number;
    signature: string;
    docComment?: string;
    domain?: string;
    score: number;
  }>;
  calls: Array<{
    callerNodeId: string;
    calleeNodeId: string;
    callerName: string;
    calleeName: string;
  }>;
  recentChanges: Array<{
    commitSha: string;
    message: string;
    authorName: string;
    committedAt: string;
    modifiedFiles: string[];
  }>;
}

/**
 * Provider that answers "give me everything related to <concept>" queries.
 * Injected when the platform's code.map capability is available (in-app agent
 * and CLI with a connected workspace).
 */
export interface CodeMapProvider {
  query(
    conceptQuery: string,
    opts?: { limit?: number; domain?: string; kinds?: Array<"file" | "symbol" | "chunk" | "commit"> },
  ): Promise<CodeMapBundle>;
}

export interface RunCodingAgentOptions {
  workspace: Workspace;
  /** Injected AI port — BYOK/unmetered in the CLI, streamAgentReply (metered) on the platform. */
  ai: AgentAi;
  instruction: string;
  model?: string;
  /** Reasoning effort for models that support it (forwarded to the AI port). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  system?: string;
  history?: ModelMessage[];
  maxSteps?: number;
  /** Per-turn budget of retries for transient model/transport errors (default 4). */
  maxRetries?: number;
  /** Model context window in tokens; auto-detected from the model slug when omitted. */
  contextWindow?: number;
  /** Compact the transcript once its estimated tokens exceed this fraction of the window (default 0.8). */
  compactionThreshold?: number;
  readOnly?: boolean;
  codeGraph?: CodeGraphProvider;
  /** Optional semantic code-map provider — enables the `code_map` tool. */
  codeMap?: CodeMapProvider;
  memory?: MemoryProvider;
  trace?: TraceStore;
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
  /**
   * Extra tools merged with the built-in workspace tools — e.g. external MCP
   * server tools the CLI materialises. Merged AFTER the workspace tools, so a
   * name collision lets an MCP tool shadow a built-in (caller's responsibility).
   */
  extraTools?: ToolSet;
  /**
   * Final transform applied to the complete tool set before the model sees it.
   * The single seam through which a caller layers cross-cutting behaviour on
   * EVERY tool — the CLI passes its permission-gate + lifecycle-hook +
   * per-tool-timeout wrapper here so one engine loop serves the REPL, one-shot,
   * `--agent`, and the fleet with identical safety wiring (no second loop).
   */
  wrapTools?: (tools: ToolSet) => ToolSet;
}

export interface RunCodingAgentResult {
  text: string;
  steps: number;
  diff: string;
  changedFiles: string[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** Prompt tokens served from the provider cache (a cache "hit"). */
    cachedInputTokens?: number;
  };
  messages: ModelMessage[];
}
