import type { ModelMessage, ToolSet } from "ai";
import type {
  AgentAi,
  MemoryProvider,
  TraceStore,
  FileLockProvider,
  DiagnosticsProvider,
} from "./ports";

/**
 * Where a {@link EngineNonFatalError} happened. Each value names a distinct
 * best-effort side effect the engine runs but must NEVER let fail the turn — so
 * instead of a silent `.catch(() => {})` the failure is routed to `onError` for
 * the consumer to log/telemeter.
 *
 * - `memory-recall` — recalling episodic memory failed; the turn degrades to no
 *   recalled context.
 * - `memory-remember` — persisting the turn's episodic memory failed.
 * - `trace-record` — writing the turn trace failed.
 * - `graph-sync` — a fire-and-forget knowledge-graph sync (file upsert / lineage
 *   edge) failed (pipeline finalization).
 * - `file-lock-release` — the turn-end batch lock release failed (the lock TTL is
 *   the ultimate backstop).
 * - `budget-wait-slow` — NOT an error but an observability breadcrumb: an
 *   interactive budget-approval wait has been pending a long time (the human's
 *   decision still ends it; nothing was auto-denied).
 */
export type EngineNonFatalPhase =
  | "memory-recall"
  | "memory-remember"
  | "trace-record"
  | "graph-sync"
  | "file-lock-release"
  | "budget-wait-slow";

/**
 * A non-fatal internal failure the engine surfaces through `onError` instead of
 * swallowing. `phase` names where it happened so a consumer can route/label it.
 */
export interface EngineNonFatalError {
  phase: EngineNonFatalPhase;
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
  readFile(
    p: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<string>;
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
  grep(
    pattern: string,
    opts?: { path?: string; glob?: string },
  ): Promise<string[]>;
  exec(
    command: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CommandResult>;
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
  | {
      type: "file-edit";
      path: string;
      bytes: number;
      /** Whether the write created the file or updated an existing one. */
      kind: "create" | "update";
      /**
       * The content-hash anchor of the file BEFORE this edit (see
       * `edit-integrity.ts#hashContent`). Absent for a create (there was no
       * prior content) and on the legacy pre-integrity write path.
       */
      beforeHash?: string;
      /** The content-hash anchor of the file AFTER this edit — the new anchor. */
      afterHash?: string;
      /**
       * Count of NEW syntax/type diagnostics this edit shipped — non-zero ONLY
       * when the model passed `expect_errors:true` to knowingly break the file
       * mid-refactor; 0 (or absent) on a gate-passing edit.
       */
      newDiagnostics?: number;
      /**
       * True when the edit declared intentional breakage (`expect_errors:true`)
       * and the gate let new diagnostics through and recorded them to the audit
       * trail. Absent on a clean edit.
       */
      declaredBreaking?: boolean;
      /** Number of substring occurrences replaced (edit_file); absent for write_file. */
      replacements?: number;
    }
  | { type: "command"; command: string; exitCode: number }
  | { type: "final-diff"; diff: string; changedFiles: string[] };

export interface CodeGraphProvider {
  query(
    operation:
      | "search"
      | "file_symbols"
      | "dependents"
      | "imports"
      | "semantic_search",
    query: string,
    limit?: number,
  ): Promise<string>;
}

/** The user's reply to an {@link AskUserCallback} clarification question. */
export interface AskUserResponse {
  /**
   * The answer text the model receives — either the exact text of a chosen
   * option, or whatever the user typed when they picked the free-text path.
   */
  answer: string;
  /** True when the user typed their own answer instead of picking an option. */
  wasFreeText: boolean;
}

/**
 * Interactive clarification callback. Supplied ONLY by a surface that actually
 * has a human to ask (the REPL). When present, `buildWorkspaceTools` registers
 * the `ask_user` tool so the agent can pause and pose a single structured
 * multiple-choice question; when absent — every headless/one-shot/chat surface
 * — the tool is never advertised, so the model cannot call a tool that would
 * block forever with nobody to answer it. Mirrors {@link CodeGraphProvider}:
 * the presence of the capability, not a surface flag, gates the tool.
 *
 * The callback resolves with the user's {@link AskUserResponse}. It MAY block
 * for as long as the human takes to decide — the caller (the REPL overlay) is
 * responsible for eventually resolving it (on choose, submit, or dismiss).
 */
export type AskUserCallback = (question: {
  question: string;
  options: string[];
}) => Promise<AskUserResponse>;

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
  /**
   * Stream-inactivity watchdog (ms). If no `fullStream` part arrives for this
   * long WITHIN a step, the step's stream is aborted and the failure is treated
   * as a RETRYABLE step error — so a transport that wedges without erroring
   * (dropped connection, silent gateway stall) re-runs the step via the normal
   * retry/backoff path instead of hanging the turn forever. The caller's
   * `signal` is composed in, so a genuine user abort is NEVER misclassified as a
   * stall. Default 180_000 (3 min). Pass `0` or a non-finite value to disable
   * the watchdog entirely (unbounded wait, the pre-watchdog behaviour).
   */
  streamStallMs?: number;
  /** Model context window in tokens; auto-detected from the model slug when omitted. */
  contextWindow?: number;
  /** Compact the transcript once its estimated tokens exceed this fraction of the window (default 0.8). */
  compactionThreshold?: number;
  readOnly?: boolean;
  codeGraph?: CodeGraphProvider;
  /**
   * Speculative tool execution (ADR-030): prefetch the model's likely next
   * reads (read_file/grep/glob follow-ups) into a per-turn promise cache while
   * the model thinks. Read-only allowlist; any other tool call invalidates the
   * cache. Default ON; this option wins over the OXAGEN_SPECULATIVE_TOOLS kill
   * switch (env value "0"/"false" disables). Requires a `workspace`.
   */
  speculativeTools?: boolean;
  /**
   * Partitioned tool dispatch (agent-engine v2 Phase 0): cap non-mutating
   * tool concurrency at 8 and serialize mutating tools behind an exclusive
   * FIFO barrier, instead of the AI SDK's unawaited, uncapped execution of
   * every call in a step. Default ON; this option wins over the
   * OXAGEN_DISPATCH_GUARD kill switch (env value "0"/"false" disables).
   */
  dispatchGuard?: boolean;
  /**
   * Tool names serialized behind the exclusive barrier IN ADDITION to the
   * built-in workspace mutators (bash/write_file/edit_file). Callers that
   * materialize capability tools pass their mutating capability aliases here
   * (`MaterializedTools.mutatingToolNames`); MCP extras a caller knows to
   * mutate belong here too. Unlisted tools keep shared (capped) concurrency.
   */
  mutatingToolNames?: readonly string[];
  /**
   * Observer for speculation cache stats (predicted/hits/misses/wasted/
   * invalidations), fired with a snapshot after every cache event. For trace
   * and eval wiring; omitted ⇒ no observation overhead.
   */
  onSpeculationStats?: (stats: {
    predicted: number;
    hits: number;
    misses: number;
    wasted: number;
    invalidations: number;
  }) => void;
  /**
   * Interactive clarification callback. Supplied ONLY by a surface with a human
   * to ask (the REPL); when present the `ask_user` tool is registered so the
   * agent can pose a structured multiple-choice question, and the system prompt
   * gains the "ask when truly ambiguous" rule. Omitted on every headless /
   * one-shot / chat surface — the tool is then never advertised. Requires a
   * `workspace` (the tool lives in the workspace tool set).
   */
  askUser?: AskUserCallback;
  memory?: MemoryProvider;
  trace?: TraceStore;
  /**
   * Graph-backed file lock (docs/specs/agent-file-locking/plan.md). Omitted
   * (undefined) ⇒ `write_file`/`edit_file` proceed unlocked — the CLI's
   * single-process, no-shared-Neo4j default. When supplied, `lockContext`
   * MUST also be supplied so the tool executor has an identity to acquire
   * under.
   */
  fileLock?: FileLockProvider | null;
  /**
   * Identity the file-lock port acquires/releases under. `agentId` MUST be
   * stable across every `runCodingAgent` call within the SAME turn (so a
   * revision round renews its own lock instead of conflicting with itself)
   * but DIFFERENT across concurrently-running turns/subagent children (so two
   * live agents correctly see each other as conflicting holders).
   * `executionId` correlates every lock this turn holds for the turn-end
   * batch release. Ignored when `fileLock` is not supplied.
   */
  lockContext?: { agentId: string; executionId: string };
  /**
   * Optional project-diagnostics provider (an incremental tsserver / LSP). When
   * supplied, the edit-integrity gate compares its before/after output on the
   * edited file in ADDITION to the built-in single-file syntax check, so a write
   * that introduces new cross-file type breakage is rejected too (unless the
   * edit passes `expect_errors:true`). Omitted ⇒ the built-in syntactic check is
   * the only gate (the CLI's default). See {@link DiagnosticsProvider}.
   */
  diagnostics?: DiagnosticsProvider;
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
  /**
   * Per-turn budget gate. Invoked after EACH committed step with the turn's
   * cumulative token usage, so a dollar ceiling is checked at every step
   * boundary. Returns "continue" to run the next step or "stop" to end the turn
   * immediately (the result then carries `stopReason: "budget"`). The engine
   * stays dependency-light — it never prices tokens: the CALLER converts usage
   * to dollars (via @oxagen/billing) and applies the budget policy, including a
   * "prompt"-mode PAUSE for approval that blocks INSIDE the guard and resolves
   * to continue (ceiling raised) or stop. Omitted ⇒ no budget (unbounded).
   *
   * MUST NOT throw — it runs on the step-commit path; a throw would be
   * misclassified as a model error and hit the retry loop. Swallow internally
   * and return "continue" on failure so a broken meter never wedges a turn.
   */
  budgetGuard?: (
    usage: RunCodingAgentResult["usage"],
  ) => Promise<"continue" | "stop">;
}

/**
 * Why {@link runCodingAgent} ended the turn. Absent ⇒ the model finished
 * naturally (a non-`tool-calls` finish reason).
 *
 * - `budget` — a per-turn dollar ceiling stopped it (the `budgetGuard` returned
 *   `"stop"`).
 * - `max-steps` — the step cap (`maxSteps`) was reached before the model
 *   finished, so the turn is EXHAUSTED, not complete. Lets a caller distinguish
 *   "ran out of room" from a clean finish (and, e.g., warn the user or continue).
 */
export type TurnStopReason = "budget" | "max-steps";

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
  /**
   * Set when the turn ended for a reason other than the model finishing —
   * currently only `"budget"` (a per-turn dollar ceiling stopped it). Lets a
   * surface tell the user WHY the turn cut off. Absent on a natural finish.
   */
  stopReason?: TurnStopReason;
}
