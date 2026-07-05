import type { ModelMessage, ToolSet } from "ai";
import type { AgentAi, MemoryProvider, TraceStore } from "./ports";

/**
 * A non-fatal internal failure the engine surfaces through `onError` instead of
 * swallowing. `phase` names where it happened so a consumer can route/label it.
 */
export interface EngineNonFatalError {
  /** "memory-recall" — recalling episodic memory failed; the turn degrades to no recalled context. */
  phase: "memory-recall";
  error: unknown;
}

/**
 * An image attached to a turn's instruction (REPL Ctrl-V paste support).
 * Becomes an `ImagePart` alongside the instruction text — see engine.ts.
 */
export interface ImageAttachment {
  /** Raw image bytes. */
  data: Buffer;
  /** IANA media type, e.g. "image/png". */
  mediaType: string;
}

/**
 * A video attached to a turn's instruction. Becomes an AI-SDK `file` content
 * part alongside the instruction text (see engine.ts) and is ONLY sent to a
 * model the caller has verified accepts video input (Gemini class,
 * `supportsVideoInput`) — a vision-only model gets sampled keyframes as
 * `images` instead, and a model that can do neither never receives a video.
 * The engine does not itself gate on model capability; the caller (the chat
 * stream route's routing decision) resolves which of `images`/`videos` to pass.
 */
export interface VideoAttachment {
  /** Raw video bytes. */
  data: Buffer;
  /** IANA media type, e.g. "video/mp4". */
  mediaType: string;
  /** Optional original filename, forwarded to the provider when present. */
  filename?: string;
}

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
  /**
   * The checked-out filesystem the coding loop reads and edits. OPTIONAL: a
   * surface with no repository — the in-app chat agent — omits it, and the loop
   * then advertises NO filesystem tools (`read_file`…`bash`), computes no diff,
   * and emits no `final-diff`. Every filesystem-bound behaviour in the engine is
   * gated on this being present.
   */
  workspace?: Workspace;
  /** Injected AI port — BYOK/unmetered in the CLI, streamAgentReply (metered) on the platform. */
  ai: AgentAi;
  instruction: string;
  /** Images to attach alongside the instruction text (multimodal content parts). Omit for a text-only turn. */
  images?: ImageAttachment[];
  /**
   * Videos to attach alongside the instruction text as AI-SDK `file` content
   * parts. Omit for a turn with no video. The caller MUST only pass this to a
   * model that accepts video input (`supportsVideoInput`); a vision-only model
   * receives sampled keyframes via `images` instead.
   */
  videos?: VideoAttachment[];
  model?: string;
  /** Reasoning effort for models that support it (forwarded to the AI port). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  system?: string;
  history?: ModelMessage[];
  maxSteps?: number;
  /** Per-turn budget of retries for transient model/transport errors (default 4). */
  maxRetries?: number;
  /**
   * Per-turn budget of context-overflow retries (compact-harder-and-retry the
   * SAME step). Default 2. A caller that forwards every raw stream part to a
   * client as it arrives (the in-app SSE translator via `onStreamPart`) passes
   * `0`: an overflow re-runs the step, which would re-forward that step's parts
   * (duplicate `start-step`, possibly duplicate text) to a client that cannot
   * un-render them. With `0` an overflow throws to the caller's catch instead —
   * matching a non-buffered transport where an oversized request surfaces as a
   * single error rather than a silent re-stream.
   */
  maxOverflowRetries?: number;
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
   * Injected sink for NON-FATAL internal failures the engine would otherwise
   * swallow — e.g. a memory-recall error that degrades the turn to no recalled
   * context. Lets each consumer decide HOW to surface it (the platform logs +
   * emits a telemetry event; the CLI writes its debug log) without the
   * dependency-light engine importing a logger or a renderer. MUST NOT throw.
   */
  onError?: (err: EngineNonFatalError) => void;
  /**
   * Raw AI-SDK `fullStream` part tap. Invoked for EVERY part of every step,
   * synchronously, as the first thing the loop does per part — BEFORE the
   * engine's own `CodingEvent` translation (which only consumes a subset:
   * text/reasoning/tool-call/-result/-error). A consumer that needs higher
   * fidelity than `CodingEvent` — the in-app SSE translator, which forwards
   * `tool-input-start/-delta`, `reasoning-start/-end`, `start-step`,
   * `finish-step`, `finish`, `error` verbatim to the browser — uses this.
   *
   * MUST NOT throw: it runs inside the engine's per-step try/catch, so a throw
   * (e.g. enqueue on a closed SSE controller) would be misclassified as a
   * model/stream error and trigger the retry path. Consumers swallow their own
   * emit failures and rely on `signal` to stop the loop.
   */
  onStreamPart?: (part: unknown) => void;
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
