/**
 * The turn pipeline — what every user prompt flows through.
 *
 * This is the orchestrator that makes the engine excellent at context and
 * accurate about completion. For each prompt it:
 *
 *   1. EVALUATE — a cheap model scores completeness + complexity and proposes
 *      context to pull and a noise-removed rewrite.
 *   2. ENHANCE  — the code graph + recalled memory are injected, grounding the
 *      agent in the real files/symbols involved.
 *   3. ROUTE    — the evaluator's chosen tier selects the worker model
 *      (cheapest tier for the job; the default evaluator is the local
 *      heuristic — see evaluate/evaluator.ts); a one-way deterministic safety
 *      floor only prevents under-spending on high-stakes domains.
 *   4. EXECUTE  — the coding agent runs the local tool loop.
 *   5. JUDGE    — a DIFFERENT model checks whether the work is actually
 *      complete. The default is the balanced tier (see `pickAdvisorModel`),
 *      dropped to the fast tier for a low-complexity, small-diff turn (see
 *      {@link pickTieredAdvisor}); `OXAGEN_LLM_ADVISOR` or a `judgeModels`
 *      panel overrides both. The one invariant is that the judge is never the
 *      model that did the work.
 *   6. REVISE   — if it isn't, the agent is sent back with the judge's findings,
 *      then re-judged, up to a bounded number of rounds.
 *
 * Every stage emits a {@link StageEvent} so the REPL can show the process live,
 * and the whole thing is recorded as a {@link TurnTrace} for `/replay`. The
 * pipeline degrades gracefully: any evaluator/judge model failure falls back to a
 * heuristic, so a turn always runs.
 *
 * Unlike the CLI `runTurn`, this version takes a {@link Workspace} and an
 * {@link AgentAi} port rather than a `cwd` string and CLI-specific modules.
 * It also does NOT check for a gateway key — that is the caller's responsibility.
 */
import type { ModelMessage, ToolSet } from "ai";
import { runCodingAgent } from "../engine";
import { estimateMessageTokens } from "../loop-driver";
import { buildSystemPrompt } from "../prompt/system-prompt";
import { evaluatePrompt } from "../evaluate/evaluator";
import {
  judgeCompleteness,
  judgePanel,
  buildRevisionPrompt,
} from "../evaluate/judge";
import { enhancePrompt } from "../evaluate/prompt-enhancer";
import { createSpecTestTracker } from "../oracle/spec-test";
import {
  runMutationGate,
  applyGateToVerdict,
  resolveMutationVerifyEnabled,
  type MutationGateResult,
} from "../verify";
import {
  specGateInstruction,
  shouldInjectSpecGate,
  buildLadderSignals,
  decideLadderPath,
  resolveJudgeSkipEnabled,
  shouldSkipJudgeReadOnly,
} from "./wiring";
import { createHash } from "node:crypto";
import {
  classifyTier,
  modelForTier,
  tierForSlug,
  tierLabel,
  accumulateUsage,
} from "../router/model-router";
import { estimateCostUsd, projectCost } from "../router/rate-card";
import {
  deriveTaskClass,
  decideMarketRoute,
  escalateTier,
  type MarketRoutingPolicy,
  type RoutingStatRow,
} from "../router/market-router";
import { emptyUsage, mergeUsage } from "../types";
import type {
  ModelTier,
  UsageTotals,
  Workspace,
  CodeGraphProvider,
  ProjectContext,
  CodingEvent,
  ImageAttachment,
  EngineNonFatalError,
  RunCodingAgentResult,
  AskUserCallback,
} from "../types";
import type {
  AgentAi,
  MemoryProvider,
  TraceStore,
  FileLockProvider,
} from "../ports";
import type {
  EnhancementTrace,
  JudgeVerdict,
  PhaseStat,
  PromptEvaluation,
  ScopeReviewDecision,
  ScopeReviewInfo,
  StageEvent,
  ToolEvent,
  TurnTrace,
} from "../trace/types";

const TIER_RANK: Record<ModelTier, number> = {
  fast: 0,
  balanced: 1,
  precise: 2,
};

/** Cap stored free-text so a single trace file can't grow without bound. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

let traceCounter = 0;
function newTraceId(): string {
  traceCounter = (traceCounter + 1) % 1_000_000;
  return `turn_${Date.now().toString(36)}_${traceCounter.toString(36)}`;
}

/**
 * Compose the coding agent's system prompt: persona + operating rules (including
 * "the user cannot see tool output — always interpret and report") + the repo's
 * project rules. Both the pipeline and bare execution paths route through here so
 * the agent gets its full behavioral contract, not just the raw project text.
 * Stable within a session (cwd/projectContext/readOnly don't change), so it keeps
 * the provider prompt cache warm across turns. The one turn-dependent input is
 * `hasLocalization` — whether ENHANCE injected an F1 candidate-locations block
 * this turn — which adds the spec's trust-but-verify rule; it is stable within a
 * turn and false on the bare path (which never runs ENHANCE).
 */
function composeAgentSystem(
  opts: RunTurnOptions,
  cwd: string,
  hasLocalization = false,
): string {
  return buildSystemPrompt({
    cwd,
    projectContext: opts.projectContext,
    readOnly: opts.readOnly,
    // Never reference a tool the model does not have: code_graph is only
    // materialized when a provider is injected.
    hasCodeGraph: Boolean(opts.codeGraph),
    // Likewise ask_user: the rule appears only when a human-in-the-loop
    // callback was supplied (an interactive surface).
    hasAskUser: Boolean(opts.askUser),
    hasLocalization,
    profile: opts.profile,
    // A named-agent persona replaces the default identity (its systemPrompt
    // becomes the preamble). Lets `--agent` and the fleet run their persona
    // through the same engine loop as every other run.
    agent: opts.agent,
  });
}

export interface RunTurnOptions {
  /** The user's prompt for this turn, exactly as typed. */
  prompt: string;
  /**
   * Images attached to this turn's prompt (REPL Ctrl-V paste support).
   * Attached only on the FIRST execution round — a judge/revise round already
   * carries the image in `history` (it's part of round 0's committed
   * messages), so resending it would just duplicate the bytes.
   */
  images?: ImageAttachment[];
  /** Workspace the agent operates on. */
  workspace: Workspace;
  /** Injected AI port — BYOK/unmetered in the CLI, metered on the platform. */
  ai: AgentAi;
  /** Prior conversation messages (for multi-turn sessions). */
  history?: ModelMessage[];
  /** Manual model override — pins the executor and skips auto-routing. */
  model?: string;
  /** Reasoning effort for models that support it (forwarded to the AI port). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Runaway backstop for the tool loop per execution round (default 256). */
  maxSteps?: number;
  /** Extra tools merged with the workspace tools (e.g. external MCP tools). */
  extraTools?: ToolSet;
  /**
   * Final transform over the tool set — the CLI's permission-gate + lifecycle-
   * hook + per-tool-timeout wrapper. Applied on every execution round so the
   * `--agent` and fleet paths get the same safety wiring as every other run
   * through the engine loop.
   */
  wrapTools?: (tools: ToolSet) => ToolSet;
  /**
   * Named-agent persona: its `systemPrompt` replaces the default coding-agent
   * identity. Combine with `bare: true` (the agent's prompt is authoritative) and
   * a `wrapTools` that restricts to the agent's tool allowlist. This is how
   * `--agent` and the fleet run through the ONE engine loop.
   */
  agent?: { name: string; systemPrompt: string };
  /** Loaded project rules (CLAUDE.md/AGENTS.md). */
  projectContext?: ProjectContext;
  /** Read-only mode: no file mutation, and the auto-revise loop is disabled. */
  readOnly?: boolean;
  /**
   * System-prompt behavioral profile, forwarded to {@link buildSystemPrompt}.
   * "interactive" (default) narrates for a live watcher; "headless" strips the
   * narration and swaps in a verification protocol for autonomous/one-shot runs
   * (SWE-bench, CI, piped stdout). Undefined ⇒ "interactive". Chosen once per
   * run, so the cached system prefix stays stable across turns.
   */
  profile?: "interactive" | "headless";
  /** Episodic session memory (recalled before, written after). */
  memory?: MemoryProvider | null;
  /** Code graph provider for prompt enhancement. */
  codeGraph?: CodeGraphProvider | null;
  /**
   * Interactive clarification callback. Supplied ONLY by a surface with a human
   * to ask (the REPL). When present, every `runCodingAgent` round this turn runs
   * gets the `ask_user` tool, and the system prompt gains the "ask when truly
   * ambiguous" rule (via `hasAskUser`). Omitted on headless / one-shot / chat
   * turns — the tool is then never advertised, since nobody could answer it.
   */
  askUser?: AskUserCallback | null;
  /** Trace sink for recording the turn record. */
  trace?: TraceStore | null;
  /**
   * Transactional file lock (ADR-021 §5, "Lock authority and file-level state
   * stay in Postgres") — the
   * SINGLE wiring point is inside `tools.ts`'s write_file/edit_file, which
   * `runCodingAgent` (via `engine.ts`) threads this straight through to.
   * `runTurn` generates one stable lock identity per turn (`lockContext`,
   * below) and passes BOTH down to every `runCodingAgent` call this turn
   * makes (including revision rounds), then batch-releases everything the
   * turn holds in its `lockContext.executionId` once the turn ends — the
   * final backstop after per-call release.
   *
   * CLI: omit or pass null (single-process, no shared lease store — unlocked).
   * Platform: inject the adapter from `@oxagen/agent/adapters`, used by both
   * the chat surface and `agent.repo.edit` (fleet dispatch) since both funnel
   * through this same shared engine (docs/adr/ADR-019-unified-agent-engine.md).
   */
  fileLock?: FileLockProvider | null;
  /**
   * Max judge→revise rounds (default 1; 0 disables auto-revision). Set via
   * `OXAGEN_MAX_REVISE_ROUNDS` env var or this option; the option wins when
   * both are set.
   */
  maxReviseRounds?: number;
  /**
   * Enable a mid-session completeness check: after this many steps in the first
   * execution round, pause, run the judge, and if incomplete inject the judge's
   * findings as a revision instruction before continuing. This catches missing
   * acceptance criteria (e.g. a required test case) early — before the agent
   * burns the rest of the step budget on redundant verification loops.
   *
   * Only applies to round 0 (the initial execution). Set via
   * `OXAGEN_MID_JUDGE_STEPS` env var or this option. Undefined / 0 disables.
   */
  midJudgeSteps?: number;
  /**
   * Wall-clock budget (ms) for the ENHANCE stage's code-graph pass. On a cold
   * store the first graph query triggers a full tree-sitter build — minutes on
   * a large repo — so headless callers bound it; whatever resolved in budget
   * is injected and the build keeps warming in the background for the agent's
   * own `code_graph` tool calls. Undefined ⇒ unbounded.
   */
  enhanceTimeoutMs?: number;
  /** Repository identifier for F8 repo-prior lookup (e.g., "django/django"). */
  repo?: string;
  /** Base directory for F8 repo-prior files (e.g., ~/.oxagen/repo-priors). */
  priorsDir?: string;
  /**
   * Judge with a PANEL of these (distinct, cross-vendor) advisor models instead
   * of a single judge — majority rules, findings unioned. Empty/undefined ⇒
   * single judge, unless `OXAGEN_JUDGE_PANEL` is set. Higher cost, higher recall
   * on incomplete work; worth it for a bench push.
   */
  judgeModels?: string[];
  /**
   * Mutation gate (layer 1): after a judged-complete round, revert the fix in
   * a shadow (test files stay put), re-run the agent's own witness test
   * command, and demand a failure — a test that still passes without the fix
   * witnesses nothing, and the verdict is overridden back into the revise
   * loop. ON by default (`OXAGEN_MUTATION_VERIFY=0` disables); this explicit
   * option wins over the env var. Deterministic — zero model calls.
   */
  mutationVerify?: boolean;
  /**
   * Mutation gate layer 2: when the witness check passes, additionally apply
   * deterministic one-line mutants to the fix's added lines and measure the
   * kill rate (how many mutants the tests catch). Each mutant costs one
   * witness-command run, so this is opt-in (or `OXAGEN_MUTATION_SCORE=1`).
   */
  mutationScore?: boolean;
  /**
   * TRIAGE / coordinator model — drives the pre-execution EVALUATE stage
   * (`evaluatePrompt`). Set via `/triage-model`. When set, the evaluator runs
   * this model instead of the free local heuristic; undefined ⇒ `OXAGEN_LLM_EVALUATOR`
   * env, else the local heuristic. The CLI planner (a separate coordinator stage
   * that lives outside the engine) reads the same triage slug directly.
   */
  triageModel?: string;
  /** Skip the eval/enhance/judge pipeline and run the bare agent. */
  bare?: boolean;
  /**
   * Fast path for conversational / lookup turns (e.g. "what's the command to
   * add an MCP server?"). Keeps the grounding stages that make an answer
   * accurate (evaluate + enhance/code-graph + docs) but skips the frontier
   * completeness judge and its revise loop when the turn produced NO file
   * changes — a pure Q&A answer has no executed evidence to verify, so the judge
   * call is waste. The zero-diff guard makes this safe even if the caller's
   * intent classifier is wrong: a fast-path turn that unexpectedly edits files
   * still gets judged. The caller is responsible for also skipping its own
   * up-front planner call for these turns. Independent of `OXAGEN_LADDER`.
   */
  fastPath?: boolean;
  /**
   * Capture full per-phase telemetry (timing, per-model token/cost breakdown,
   * tool calls + results, the injected context) onto the trace, for `/verbose`.
   */
  verbose?: boolean;
  /** Abort the turn (e.g. user hit Ctrl-C / Esc). */
  signal?: AbortSignal;
  /**
   * Per-turn dollar budget gate. Forwarded to every `runCodingAgent` round this
   * turn runs, but wrapped so it sees the turn's CUMULATIVE usage (prior rounds'
   * tokens carried as a baseline) — the engine guard alone only sees one round's
   * usage, so this is what makes the ceiling a true per-TURN cap across the
   * evaluate→execute→judge→revise rounds. Omitted ⇒ no budget. Build it with
   * `createTurnBudgetGuard` from @oxagen/billing. MUST NOT throw.
   */
  budgetGuard?: (
    usage: RunCodingAgentResult["usage"],
  ) => Promise<"continue" | "stop">;
  /**
   * Verified-Outcome Market Router policy for this turn. Absent / `mode: "off"`
   * ⇒ exactly today's deterministic routing (the default). `shadow` computes the
   * market decision, records the outcome, and annotates the trace but keeps
   * today's routing. `enforce` uses the market decision for the worker model and
   * escalates the worker one tier when the judge rejects a revision round.
   */
  routingPolicy?: MarketRoutingPolicy;
  /**
   * Pre-fetched observed-outcome stats snapshot the market router reads (the
   * engine has no ClickHouse access — a server caller injects this). Absent ⇒
   * the market router always falls back to deterministic routing.
   */
  routingStats?: RoutingStatRow[];
  /**
   * Fire-and-forget sink for each round's routing outcome (task class, model,
   * verified?, cost, latency, mode). A server caller wires this to
   * `recordRouterOutcome`. MUST NOT throw into the pipeline — the engine wraps
   * it defensively, but keep it side-effect-only.
   */
  onRouteOutcome?: (outcome: RouteOutcome) => void | Promise<void>;
  /**
   * Fired once, after ROUTE and before EXECUTE, with a full pre-execution
   * snapshot (enhanced prompt + estimated cost). Always non-blocking display —
   * use it to show the user what is about to run. Independent of `confirmScope`.
   */
  onScopeReview?: (info: ScopeReviewInfo) => void;
  /**
   * Optional pre-execution gate. When provided, EXECUTE waits on this promise.
   * Resolve `{ proceed: false }` to cancel the turn cleanly before any model
   * execution; `{ proceed: true, prompt }` to run (optionally with an edited
   * prompt that replaces the enhanced prompt). When omitted, execution proceeds
   * with no gate.
   */
  confirmScope?: (info: ScopeReviewInfo) => Promise<ScopeReviewDecision>;
  /** Live stage events for the UI. */
  /**
   * Injected sink for non-fatal internal engine failures (e.g. memory-recall
   * failure). Forwarded to the underlying coding-agent turns so a consumer can
   * log/telemeter them; never throws. See RunCodingAgentOptions.onError.
   */
  onError?: (err: EngineNonFatalError) => void;
  onStage?: (e: StageEvent) => void;
  /** Streamed assistant text deltas. */
  onText?: (delta: string) => void;
  /** Streamed model reasoning / chain-of-thought deltas (shown dim in the CLI). */
  onReasoning?: (delta: string) => void;
  /** Fired when the model invokes a tool (the moment the call streams in). */
  onToolCall?: (name: string, input: unknown) => void;
  /**
   * Fired when a tool call completes (or errors), with real per-tool timing.
   * Together with `onToolCall` this brackets tool execution, so callers'
   * inactivity guards can treat an in-flight tool as progress instead of
   * aborting healthy multi-minute test runs.
   */
  onToolEvent?: (e: { name: string; ok: boolean; durationMs: number }) => void;
  /**
   * Fired at the end of each execution round with the cumulative `git diff` of
   * the changed files and the changed-file list. Lets the UI render the code
   * changes (syntax-highlighted diff) as they land.
   */
  onFileChange?: (diff: string, changedFiles: string[]) => void;
  /**
   * Fired the moment a write_file/edit_file lands on disk, with whether the
   * write created the file or updated an existing one. Unlike `onFileChange`
   * (end-of-round cumulative diff) this is per-edit, so a UI can render each
   * file's diff as soon as the agent touches it.
   */
  onFileEdit?: (e: {
    path: string;
    kind: "create" | "update";
    bytes: number;
    /** Content-hash anchor before the edit (absent for a create). */
    beforeHash?: string;
    /** Content-hash anchor after the edit. */
    afterHash?: string;
    /** New syntax/type diagnostics shipped (non-zero only under declared breakage). */
    newDiagnostics?: number;
    /** True when the edit declared intentional mid-refactor breakage. */
    declaredBreaking?: boolean;
    /** Substring occurrences replaced (edit_file); absent for write_file. */
    replacements?: number;
  }) => void;
}

export interface RunTurnResult {
  /** The agent's final assistant text (last execution round). */
  text: string;
  /** Tool-loop steps across all execution rounds. */
  steps: number;
  /** Full message history including this turn's assistant/tool messages. */
  messages: ModelMessage[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** Prompt tokens served from the provider cache (a cache "hit"), summed across rounds. */
    cachedInputTokens?: number;
  };
  /** The full, persisted record of how this turn was handled. */
  trace: TurnTrace;
}

/** Pull the file path from a write/edit tool call, or a command from bash. */
function collectActivity(
  name: string,
  input: unknown,
  files: Set<string>,
  commands: string[],
): void {
  const obj = (input ?? {}) as {
    path?: unknown;
    command?: unknown;
    cmd?: unknown;
  };
  if (
    (name === "write_file" || name === "edit_file") &&
    typeof obj.path === "string"
  ) {
    files.add(obj.path);
  }
  if (name === "bash") {
    const cmd = obj.command ?? obj.cmd;
    if (typeof cmd === "string") commands.push(truncate(cmd, 120));
  }
}

/**
 * Record a completed tool call into the verbose telemetry buffer.
 *
 * The engine's `tool-result` event already carries everything we need with real,
 * step-granular timing (measured in engine.ts from `onStepFinish`): the tool
 * name, its capped input/result, the wall-clock `durationMs` of the step that
 * ran it, and whether it errored. We reconstruct `startedAt`/`finishedAt` from
 * that duration so each entry has an absolute window. No-op when verbose is off
 * or the event is not a tool result. Shared by the full-pipeline and bare paths
 * so both produce identical `/verbose` timing.
 */
function captureToolEvent(
  e: CodingEvent,
  toolEvents: ToolEvent[],
  verbose: boolean | undefined,
): void {
  if (!verbose || e.type !== "tool-result") return;
  const finishedAt = Date.now();
  toolEvents.push({
    name: e.name,
    input: e.input,
    result: e.result,
    startedAt: finishedAt - e.durationMs,
    finishedAt,
    durationMs: e.durationMs,
    ok: e.ok,
  });
}

/**
 * Run one prompt through the full pipeline. Throws if the workspace or AI port
 * is invalid; otherwise always produces a trace.
 */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const cwd = opts.workspace.root;
  const startedAt = Date.now();
  const filesTouched = new Set<string>();
  const commandsRun: string[] = [];
  const onToolCall = (name: string, input: unknown): void => {
    collectActivity(name, input, filesTouched, commandsRun);
    opts.onToolCall?.(name, input);
  };
  // Agent file locking (docs/specs/agent-file-locking/plan.md): ONE lock
  // identity for the whole turn, generated up front (before any tool call) so
  // write_file/edit_file can acquire under it from the very first round.
  // Same value used as both agentId (renew semantics: this turn's OWN repeat
  // edits never conflict with themselves) and executionId (turn-end batch
  // release correlation) — distinct from `trace.id`, which is only assembled
  // at the END of the turn and so can't be known early enough to acquire
  // under. A DIFFERENT concurrently-running `runTurn`/`runCodingAgent` call
  // (another chat turn, another fleet subagent child) gets its OWN id here,
  // so two live agents correctly see each other as conflicting holders.
  const turnLockId = newTraceId();
  const lockContext = opts.fileLock
    ? { agentId: turnLockId, executionId: turnLockId }
    : undefined;
  // Verbose telemetry accumulators (left empty/undefined when verbose is off).
  const phases: PhaseStat[] = [];
  const toolEvents: ToolEvent[] = [];
  // Reasoning captured per execution round — persisted on the trace so the
  // agent's thinking survives the turn.
  const thinkingLog: Array<{ round: number; text: string }> = [];

  // ── Bare mode: skip the pipeline, run the agent directly. ──
  if (opts.bare) {
    return runBare(
      opts,
      cwd,
      startedAt,
      filesTouched,
      commandsRun,
      onToolCall,
      phases,
      toolEvents,
      thinkingLog,
    );
  }

  let usage = emptyUsage();

  // ── 1. EVALUATE ──
  const evalStart = Date.now();
  const evaluation = await evaluatePrompt(
    { prompt: opts.prompt, model: opts.triageModel, signal: opts.signal },
    opts.ai,
  );
  phases.push(
    phaseStat("evaluate", 0, evalStart, evaluation.model, evaluation.usage),
  );
  usage = mergeUsage(usage, evaluation.usage);
  opts.onStage?.({
    kind: "evaluate",
    label: `evaluated · completeness ${evaluation.completeness}/100 · complexity ${evaluation.complexity}/100`,
    detail: evaluation.fallback
      ? "heuristic"
      : evaluation.model.split("/").pop(),
  });

  // ── 2. ENHANCE ──
  const enhanceStart = Date.now();
  const enhanced = await enhancePrompt({
    prompt: evaluation.refinedPrompt,
    codeGraph: opts.codeGraph,
    memory: opts.memory,
    extraQueries: evaluation.contextQueries,
    timeoutMs: opts.enhanceTimeoutMs,
    repo: opts.repo,
    priorsDir: opts.priorsDir,
  });
  phases.push(phaseStat("enhance", 0, enhanceStart, undefined, emptyUsage()));
  const enhancement: EnhancementTrace = {
    prompt: enhanced.prompt,
    context: enhanced.context,
    resolved: enhanced.resolved,
    lessonCount: enhanced.hasMemory ? 1 : 0,
    source: enhancementSource(enhanced.resolved.length, enhanced.hasMemory),
    startedAt: enhanced.startedAt,
    finishedAt: enhanced.finishedAt,
    durationMs: enhanced.durationMs,
    retrieval: enhanced.retrieval,
  };
  // usedSemanticFallback never adds to `resolved` (see enhancePrompt: the
  // semantic hits are pushed to `sections`/the injected prompt, not to
  // `resolved`), so it must be its own arm of this condition — otherwise a
  // prompt that resolves nothing literally but DOES get real semantically-
  // retrieved context wrongly narrates "no extra context found" even though
  // the agent's prompt actually carries that context.
  opts.onStage?.({
    kind: "enhance",
    label:
      enhanced.resolved.length ||
      enhanced.hasMemory ||
      enhanced.usedSemanticFallback
        ? `enhanced · ${enhanced.resolved.length} code refs${enhanced.usedSemanticFallback ? " (+semantic)" : ""} · ${enhanced.hasMemory ? "memory" : "no memory"}`
        : "enhanced · no extra context found",
  });

  // ── 3. ROUTE ──
  const routeStart = Date.now();
  // Market-aware routing (flag-gated). `routed` is mutated in place when the
  // market router escalates the worker tier on a judge rejection — runSegment
  // reads `routed.model` at call time, so the escalated model flows into the
  // next round. The INITIAL worker model is captured for budget-guard repricing.
  const routed = selectMarketModel(opts, evaluation);
  const initialWorkerModel = routed.model;
  phases.push(phaseStat("route", 0, routeStart, undefined, emptyUsage()));
  opts.onStage?.({
    kind: "route",
    label: `model · ${tierLabel(routed.tier)} (${routed.model.split("/").pop()})`,
    detail: routed.rationale,
  });

  // ── 4. EXECUTE (+ 5. JUDGE / 6. REVISE loop) ──
  // Order: explicit option → OXAGEN_MAX_REVISE_ROUNDS env → default 1 (mirrors
  // the OXAGEN_MID_JUDGE_STEPS env pattern below). 0 is a meaningful value
  // (disables auto-revise), so the env parse only falls through on a
  // genuinely invalid/absent var, not on 0.
  const maxReviseRoundsEnv = Number(process.env["OXAGEN_MAX_REVISE_ROUNDS"]);
  const envMaxReviseRounds =
    Number.isFinite(maxReviseRoundsEnv) && maxReviseRoundsEnv >= 0
      ? maxReviseRoundsEnv
      : undefined;
  const maxRounds = Math.max(
    0,
    opts.maxReviseRounds ?? envMaxReviseRounds ?? 1,
  );
  const judgeRounds: JudgeVerdict[] = [];
  // One entry per judged-complete round the mutation gate examined (usually
  // exactly one — the loop breaks after a complete verdict survives the gate).
  const mutationGates: MutationGateResult[] = [];
  let history = opts.history ?? [];
  let prompt = enhanced.prompt;

  // ── Scope review (optional) ──
  // Surfaces the fully-enhanced prompt + a rough pre-flight cost estimate right
  // before any model execution happens, so a caller (the CLI) can show the user
  // what is about to run and — if `confirmScope` is wired — gate execution
  // behind a confirmation. `onScopeReview` alone is pure display and never
  // blocks; `confirmScope` is the only thing that can cancel or edit the turn.
  {
    // Heuristic pre-flight estimate only (chars/4, same convention as
    // loop-driver's estimateMessageTokens) — never billed usage, just enough
    // to give the user a ballpark before the executor actually runs.
    const estimatedInputTokens =
      Math.ceil(enhanced.prompt.length / 4) +
      estimateMessageTokens(history) +
      Math.ceil(
        composeAgentSystem(opts, cwd, enhanced.hasLocalization).length / 4,
      );
    const estimatedOutputTokens = Math.round(
      400 + (evaluation.complexity / 100) * 4000,
    );
    const costProjection = projectCost(routed.model, {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
    });
    const scopeInfo: ScopeReviewInfo = {
      originalPrompt: opts.prompt,
      refinedPrompt: evaluation.refinedPrompt,
      enhancedPrompt: enhanced.prompt,
      context: enhanced.context,
      model: routed.model,
      tier: routed.tier,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd: costProjection.totalUsd,
    };
    opts.onScopeReview?.(scopeInfo);

    if (opts.confirmScope) {
      const decision: ScopeReviewDecision = await opts.confirmScope(scopeInfo);
      if (!decision.proceed) {
        opts.onStage?.({
          kind: "complete",
          label: "cancelled at scope review",
        });
        const cancelText =
          "⛔ Cancelled at scope review — nothing was executed.";
        const trace = assembleTrace({
          cwd,
          originalPrompt: opts.prompt,
          evaluation,
          enhancement,
          routed,
          response: cancelText,
          filesTouched: [],
          commandsRun: [],
          judgeRounds: [],
          finalComplete: true,
          steps: 0,
          usage,
          startedAt,
          verbose: opts.verbose,
          phases,
          toolEvents,
          thinkingLog,
        });
        if (opts.trace) {
          void Promise.resolve(opts.trace.record(trace)).catch(
            (error: unknown) =>
              opts.onError?.({ phase: "trace-record", error }),
          );
        }
        return {
          text: cancelText,
          steps: 0,
          messages: history,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            // No execution round has run yet at the scope-review gate, so no
            // provider cache reads have happened either — always 0 here.
            cachedInputTokens: 0,
          },
          trace,
        };
      }
      if (decision.prompt && decision.prompt !== enhanced.prompt) {
        // Flow the edited prompt into what EXECUTE actually runs, and reflect
        // it on the trace so `/replay` shows what really happened.
        enhanced.prompt = decision.prompt;
        enhancement.prompt = decision.prompt;
        prompt = decision.prompt;
      }
    }
  }

  let lastText = "";
  let totalSteps = 0;
  // Cache-read tokens summed across execution rounds (drives the CLI status
  // line's cache "hit" counter). Tracked alongside — not inside — UsageTotals,
  // which is cost accounting and has no cache field.
  let cachedInputTokens = 0;

  // Per-turn budget baseline: the engine guard sees only ONE round's usage, but
  // the budget is a per-TURN cap, so carry a running baseline of the tokens
  // spent by completed rounds (updated at each round start from the turn's
  // `usage`/`cachedInputTokens` accumulators) and add it before delegating to
  // the caller's guard. One wrapped guard, defined once, reads the mutable
  // baseline — so a "prompt"-mode approval's raised ceiling (held inside the
  // caller's guard) persists across rounds. Passed to every runCodingAgent call.
  const budgetBaseline = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  // Budget-guard tier-escalation repricing. The caller's guard prices the whole
  // turn against ONE reference model, but market-router `enforce` mode can
  // escalate the worker to a pricier tier mid-turn. The token-based guard closure
  // can't be re-keyed to a new model, so we reprice the ESCALATION DELTA against
  // the engine rate card here: the current round's tokens are scaled by the cost
  // ratio of the running model vs the turn's INITIAL worker model, and each
  // completed escalated round's premium accumulates in `budgetEscalationPremium`
  // (the reset-from-`usage` baseline below is raw tokens and would otherwise lose
  // it). When nothing escalates (routed.model === initialWorkerModel) the factor
  // is exactly 1, so a non-escalated turn passes raw tokens straight through.
  // Exact when the guard's reference model equals the initial worker (the
  // common/pinned case); a conservative premium approximation otherwise.
  const budgetEscalationPremium = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  const escalationFactor = (u: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }): number => {
    if (routed.model === initialWorkerModel) return 1;
    const usage = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cachedTokens: u.cachedInputTokens ?? 0,
    };
    const base = estimateCostUsd(initialWorkerModel, usage);
    if (base <= 0) return 1;
    return estimateCostUsd(routed.model, usage) / base;
  };
  const turnBudgetGuard: RunTurnOptions["budgetGuard"] = opts.budgetGuard
    ? (u) => {
        const f = escalationFactor(u);
        const inputTokens =
          budgetBaseline.inputTokens +
          budgetEscalationPremium.inputTokens +
          (u.inputTokens ?? 0) * f;
        const outputTokens =
          budgetBaseline.outputTokens +
          budgetEscalationPremium.outputTokens +
          (u.outputTokens ?? 0) * f;
        const cachedInputTokens =
          budgetBaseline.cachedInputTokens +
          budgetEscalationPremium.cachedInputTokens +
          (u.cachedInputTokens ?? 0) * f;
        return opts.budgetGuard!({
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens,
        });
      }
    : undefined;

  // Mid-session judge: run the agent in two halves on round 0, checking
  // completeness at the midpoint so missing acceptance criteria (e.g. a
  // required test case) are caught before the agent burns the remaining budget
  // on redundant verification loops. Controlled by `midJudgeSteps` option or
  // the OXAGEN_MID_JUDGE_STEPS env var. Zero / unset disables.
  const midJudgeStepsEnv = Number(process.env["OXAGEN_MID_JUDGE_STEPS"]);
  const midJudgeSteps =
    opts.midJudgeSteps ??
    (Number.isFinite(midJudgeStepsEnv) && midJudgeStepsEnv > 0
      ? midJudgeStepsEnv
      : 0);

  // F2: Spec-first oracle tracker. Watches for a repro signal: test-like bash command
  // with failing exit → later same command passing exit. State: 'none' (no failing test
  // seen), 'failing' (test failed), or 'flipped' (was failing, now passes).
  const tracker = createSpecTestTracker();

  // F2/F3 feature flags.
  const specGateEnabled = Boolean(process.env["OXAGEN_SPEC_GATE"]);
  // ADR-021 §1: deterministic judge-skip is the DEFAULT; a falsey OXAGEN_LADDER
  // opts OUT and forces the frontier judge to run every round.
  const judgeSkipEnabled = resolveJudgeSkipEnabled(process.env);

  /** Run one execution segment and accumulate its results into shared state. */
  async function runSegment(
    segPrompt: string,
    segHistory: typeof history,
    segMaxSteps: number | undefined,
    segRound: number,
    segImages: typeof opts.images,
    segCommandOutputs: Array<{ command: string; output: string; ok: boolean }>,
  ) {
    let segReasoning = "";
    const segResult = await runCodingAgent({
      workspace: opts.workspace,
      ai: opts.ai,
      instruction: segPrompt,
      images: segImages,
      model: routed.model,
      effort: opts.effort,
      system: composeAgentSystem(opts, cwd, enhanced.hasLocalization),
      history: segHistory,
      maxSteps: segMaxSteps,
      extraTools: opts.extraTools,
      wrapTools: opts.wrapTools,
      readOnly: opts.readOnly,
      codeGraph: opts.codeGraph ?? undefined,
      askUser: opts.askUser ?? undefined,
      memory: opts.memory ?? undefined,
      onError: opts.onError,
      signal: opts.signal,
      budgetGuard: turnBudgetGuard,
      fileLock: opts.fileLock,
      lockContext,
      onEvent: (e) => {
        if (e.type === "text") opts.onText?.(e.delta);
        if (e.type === "reasoning") {
          opts.onReasoning?.(e.delta);
          segReasoning += e.delta;
        }
        if (e.type === "tool-call") onToolCall(e.name, e.input);
        if (e.type === "tool-result") {
          opts.onToolEvent?.({
            name: e.name,
            ok: e.ok,
            durationMs: e.durationMs,
          });
          if (e.name === "bash") {
            let command = e.input;
            try {
              const parsed = JSON.parse(e.input) as { command?: unknown };
              if (typeof parsed.command === "string") command = parsed.command;
            } catch {
              /* input wasn't JSON — keep the stringified form */
            }
            segCommandOutputs.push({ command, output: e.result, ok: e.ok });
            // F2: Feed the spec-test oracle. CodingEvent only exposes boolean ok,
            // so exitCode is a 0/1 mapping.
            tracker.observe({ command, exitCode: e.ok ? 0 : 1 });
          }
        }
        if (e.type === "file-edit")
          opts.onFileEdit?.({
            path: e.path,
            kind: e.kind,
            bytes: e.bytes,
            beforeHash: e.beforeHash,
            afterHash: e.afterHash,
            newDiagnostics: e.newDiagnostics,
            declaredBreaking: e.declaredBreaking,
            replacements: e.replacements,
          });
        if (e.type === "final-diff")
          opts.onFileChange?.(e.diff, e.changedFiles);
        captureToolEvent(e, toolEvents, opts.verbose);
      },
    });
    if (segReasoning.trim())
      thinkingLog.push({ round: segRound, text: segReasoning });
    return segResult;
  }

  for (let round = 0; ; round++) {
    if (round > 0) {
      opts.onStage?.({
        kind: "revise",
        label: `revising · round ${round} (incomplete work)`,
      });
    }
    opts.onStage?.({
      kind: "execute",
      label: round === 0 ? "executing" : `executing · revision ${round}`,
    });

    const execStart = Date.now();
    // Snapshot the turn's cumulative usage as this round's budget baseline, so
    // the per-turn ceiling accounts for every prior round (evaluate + earlier
    // execute/judge rounds) — see `turnBudgetGuard` above.
    budgetBaseline.inputTokens = usage.inputTokens;
    budgetBaseline.outputTokens = usage.outputTokens;
    budgetBaseline.cachedInputTokens = cachedInputTokens;
    // Capture bash command outputs THIS round so the judge sees test results
    // (the decisive completeness signal), not just the command strings.
    const roundCommandOutputs: Array<{
      command: string;
      output: string;
      ok: boolean;
    }> = [];

    let result: Awaited<ReturnType<typeof runCodingAgent>>;

    // Round 0 with mid-session judge: run the first half, judge, then continue.
    // The combined result is returned with merged usage/steps so the standard
    // post-loop accounting below handles it identically to the non-mid-judge path.
    if (round === 0 && midJudgeSteps > 0 && !opts.readOnly) {
      // ── Phase A: first half of execution ──
      const phaseAResult = await runSegment(
        prompt,
        history,
        midJudgeSteps,
        round,
        opts.images,
        roundCommandOutputs,
      );
      for (const f of phaseAResult.changedFiles) filesTouched.add(f);

      // ── Mid-session judge (non-fatal: failure continues to phase B without gap injection) ──
      // F2: Spec-gate short-circuit — when no failing repro has been executed yet,
      // the corrective instruction is already decided, so skip the mid-judge model
      // call entirely (its verdict would be discarded) and go straight to phase B.
      if (shouldInjectSpecGate(tracker, specGateEnabled)) {
        opts.onStage?.({
          kind: "judge",
          label:
            "spec gate: no failing repro yet — skipping mid-judge, injecting repro instruction",
        });
        prompt = specGateInstruction();
      } else if (
        !opts.signal?.aborted &&
        // Perf: only spend a mid-session judge when phase A produced something to
        // verify. If the agent spent the first half purely exploring (no files
        // written, no commands run), the judge has no executed evidence to grade
        // — the call would burn tokens+latency to conclude "nothing yet". Skip it
        // and let phase B keep working. Mirrors the read-only / spec-gate skips.
        (phaseAResult.changedFiles.length > 0 || roundCommandOutputs.length > 0)
      ) {
        opts.onStage?.({
          kind: "judge",
          label: "mid-session check · verifying completeness so far",
        });
        const midJudgeStart = Date.now();
        const midVerdict = await judgeCompleteness(
          {
            request: opts.prompt,
            response: phaseAResult.text,
            filesTouched: [...filesTouched],
            commandsRun,
            diff: phaseAResult.diff,
            commandOutputs: roundCommandOutputs,
            steps: phaseAResult.steps,
            executorModel: routed.model,
            signal: opts.signal,
          },
          opts.ai,
        ).catch(() => null);
        if (midVerdict) {
          phases.push(
            phaseStat(
              "judge",
              -1,
              midJudgeStart,
              midVerdict.model,
              midVerdict.usage,
            ),
          );
          usage = mergeUsage(usage, midVerdict.usage);
          opts.onStage?.({
            kind: "judge",
            label: midVerdict.complete
              ? `mid-session: complete so far · ${midVerdict.confidence}% confident`
              : `mid-session: ${midVerdict.findings.length} gap(s) found — injecting into phase B`,
            detail: `advisor: ${midVerdict.model.split("/").pop()}`,
          });
          // Standard mid-judge: inject findings as the phase B instruction so the agent
          // addresses missing acceptance criteria before burning the remaining step budget.
          if (!midVerdict.complete && midVerdict.findings.length > 0) {
            prompt =
              `[Mid-session review] The following gaps were identified after the first ` +
              `${phaseAResult.steps} steps. Address them in the remaining work:\n` +
              midVerdict.findings.map((f) => `- ${f}`).join("\n") +
              `\n\nContinue working on the original task.`;
          }
        }
      }

      // ── Phase B: continue with remaining step budget ──
      opts.onStage?.({
        kind: "execute",
        label: "executing · phase B (post mid-session check)",
      });
      const remainingSteps =
        opts.maxSteps !== undefined
          ? Math.max(1, opts.maxSteps - phaseAResult.steps)
          : undefined;
      const phaseBResult = await runSegment(
        prompt,
        phaseAResult.messages,
        remainingSteps,
        round,
        undefined, // images already sent in phase A
        roundCommandOutputs,
      );

      // Combine A + B into a single result for the standard post-loop accounting.
      result = {
        ...phaseBResult,
        text:
          (phaseAResult.text ? phaseAResult.text + "\n" : "") +
          phaseBResult.text,
        steps: phaseAResult.steps + phaseBResult.steps,
        usage: {
          inputTokens:
            (phaseAResult.usage.inputTokens ?? 0) +
            (phaseBResult.usage.inputTokens ?? 0),
          outputTokens:
            (phaseAResult.usage.outputTokens ?? 0) +
            (phaseBResult.usage.outputTokens ?? 0),
          totalTokens:
            (phaseAResult.usage.totalTokens ?? 0) +
            (phaseBResult.usage.totalTokens ?? 0),
          cachedInputTokens:
            (phaseAResult.usage.cachedInputTokens ?? 0) +
            (phaseBResult.usage.cachedInputTokens ?? 0),
        },
      };
      // Reset prompt to original for the end-of-round judge input below.
      prompt = enhanced.prompt;
    } else {
      // Standard single-segment execution.
      result = await runSegment(
        prompt,
        history,
        opts.maxSteps,
        round,
        round === 0 ? opts.images : undefined,
        roundCommandOutputs,
      );
    }

    const execUsage = accumulateUsage(emptyUsage(), routed.model, result.usage);
    phases.push(
      phaseStat("execute", round, execStart, routed.model, execUsage),
    );
    usage = mergeUsage(usage, execUsage);
    history = result.messages;
    lastText = result.text;
    totalSteps += result.steps;
    cachedInputTokens += result.usage.cachedInputTokens ?? 0;

    // Union the git-diff file list into filesTouched. This is the ground truth
    // for what changed and supplements tool-call events (which may not fire in
    // all execution environments — e.g. when onStepFinish is not called).
    for (const f of result.changedFiles) filesTouched.add(f);

    // ── 5. JUDGE (or deterministic judge-skip) ──
    const judgeStart = Date.now();

    // ADR-021 §1: the deterministic judge-skip is ON by default (opt out with a
    // falsey OXAGEN_LADDER). Never spend a frontier completeness judge where
    // executed evidence already settles the outcome.
    let verdict: (typeof judgeRounds)[0] | undefined;
    // Fast-path conversational turn that changed nothing: the caller classified
    // this as a lookup/Q&A and no files were touched, so there is no executed
    // evidence for a frontier completeness judge (and its revise loop) to
    // verify — pure waste. Guarded on zero files touched so a MISCLASSIFIED turn
    // that DID edit files still gets judged; classification accuracy only gates
    // the caller's up-front planner skip, never this safety net. Independent of
    // OXAGEN_LADDER — this is a caller opt-in, not a ladder rung.
    if (opts.fastPath && filesTouched.size === 0) {
      verdict = {
        complete: true,
        confidence: 100,
        findings: [],
        remainingWork: [],
        model: "deterministic/fast-path",
        usage: emptyUsage(),
        fallback: false,
        reasoning:
          "Fast-path conversational turn with no file changes — nothing to verify; judge skipped.",
      };
      opts.onStage?.({
        kind: "judge",
        label: "fast path: skipped judge",
        detail: "no file changes to verify",
      });
    } else if (judgeSkipEnabled) {
      // (1) Read-only turn that changed nothing: the judge can never trigger a
      // revise (canRevise gates on !readOnly) and there is no diff to verify, so
      // a judge call here is pure waste. Settle it deterministically.
      if (
        shouldSkipJudgeReadOnly({
          readOnly: !!opts.readOnly,
          diff: result.diff,
        })
      ) {
        verdict = {
          complete: true,
          confidence: 100,
          findings: [],
          remainingWork: [],
          model: "deterministic/read-only",
          usage: emptyUsage(),
          fallback: false,
          reasoning:
            "Read-only turn with no file changes — nothing to verify; judge skipped.",
        };
        opts.onStage?.({
          kind: "judge",
          label: "read-only turn: skipped judge",
          detail: "no file changes to verify",
        });
      } else {
        // (2) Ladder fast-path: oracle flipped + touched tests green + diff within
        // budget — executed tests already prove completion, so skip the judge.
        const signals = buildLadderSignals({
          tracker,
          diff: result.diff,
          filesTouchedCount: filesTouched.size,
          stepsUsed: result.steps,
        });
        const decision = decideLadderPath({
          signals,
          currentRung: Math.min(round, 3) as 0 | 1 | 2 | 3,
          ladderEnabled: judgeSkipEnabled,
        });

        if (decision && decision.action === "submit-fast") {
          verdict = {
            complete: true,
            confidence: 95,
            findings: [],
            remainingWork: [],
            model: "ladder/fast-path",
            usage: emptyUsage(),
            fallback: false,
            reasoning: `Ladder fast-path: oracle ${signals.oracle}, tests ${signals.touchedTestsGreen ? "green" : "red"}, diff ${signals.diffLines}/${process.env["OXAGEN_DIFF_BUDGET"] ?? 120} lines`,
          };
          opts.onStage?.({
            kind: "judge",
            label: "ladder fast-path: skipped judge",
            detail: `oracle ${signals.oracle}, diff ${signals.diffLines} lines`,
          });
        }
      }
    }

    // Standard judge path (if not deterministically skipped).
    if (!verdict) {
      const judgeInput = {
        request: opts.prompt,
        response: result.text,
        filesTouched: [...filesTouched],
        commandsRun,
        // Ground-truth evidence: the real diff + the outputs of commands run
        // this round (test results are decisive for completeness).
        diff: result.diff,
        commandOutputs: roundCommandOutputs,
        steps: result.steps,
        executorModel: routed.model,
        signal: opts.signal,
      };
      const usePanel =
        (opts.judgeModels && opts.judgeModels.length > 0) ||
        !!process.env["OXAGEN_JUDGE_PANEL"];
      verdict = usePanel
        ? await judgePanel(judgeInput, opts.ai, opts.judgeModels)
        : await judgeCompleteness(
            {
              ...judgeInput,
              // Perf #5: default a low-complexity, small-diff turn to a fast judge.
              // undefined ⇒ judgeCompleteness uses pickAdvisorModel (balanced default),
              // and an explicit OXAGEN_LLM_ADVISOR always overrides this.
              advisorModel: pickTieredAdvisor(
                routed.model,
                evaluation.complexity,
                diffChangedLines(result.diff),
              ),
            },
            opts.ai,
          );
      opts.onStage?.({
        kind: "judge",
        label: verdict.complete
          ? `judged complete · ${verdict.confidence}% confident`
          : `judged INCOMPLETE · ${verdict.findings.length} gap(s)`,
        detail: `advisor: ${verdict.model.split("/").pop()}${verdict.fallback ? " (heuristic)" : ""}`,
      });
    }

    // ── 5b. MUTATION GATE (deterministic, zero model calls) ──
    // A judged-complete coding turn must prove its tests witness the fix:
    // revert the fix in a shadow (tests stay put), re-run the agent's own
    // passing test command, and demand a failure. Still green without the
    // fix ⇒ the green is false — override the verdict so the EXISTING revise
    // loop sends the agent back before the user ever sees it. Fail-open: any
    // condition the gate can't check faithfully yields "skipped", and the
    // shadow is always restored (a failed restore throws — loudly).
    if (
      verdict.complete &&
      !opts.readOnly &&
      !opts.signal?.aborted &&
      resolveMutationVerifyEnabled(process.env, opts.mutationVerify) &&
      result.diff.trim() !== ""
    ) {
      const gateStart = Date.now();
      const timeoutEnv = Number(process.env["OXAGEN_MUTATION_TIMEOUT_MS"]);
      const gate = await runMutationGate(
        opts.workspace,
        result.diff,
        {
          lastOutcomes: tracker.lastOutcomes(),
          flippedBy: tracker.flippedBy(),
        },
        {
          score:
            opts.mutationScore ?? Boolean(process.env["OXAGEN_MUTATION_SCORE"]),
          ...(Number.isFinite(timeoutEnv) && timeoutEnv > 0
            ? { timeoutMsPerCommand: timeoutEnv }
            : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          onStart: ({ commands }) =>
            opts.onStage?.({
              kind: "judge",
              label:
                "mutation gate: reverting fix to prove the tests witness it",
              ...(commands[0] ? { detail: commands[0] } : {}),
            }),
        },
      );
      mutationGates.push(gate);
      if (gate.status !== "skipped") {
        opts.onStage?.({
          kind: "judge",
          label:
            gate.status === "witnessed"
              ? "mutation gate: tests fail without the fix — the green is real"
              : "mutation gate: VACUOUS — tests still pass without the fix",
          detail:
            `${gate.runs.length} witness run(s) · ${gate.durationMs}ms` +
            (gate.score
              ? ` · mutant kill rate ${Math.round(gate.score.killRate * 100)}%`
              : ""),
        });
        phases.push(
          phaseStat(
            "judge",
            round,
            gateStart,
            "deterministic/mutation-gate",
            emptyUsage(),
          ),
        );
      }
      verdict = applyGateToVerdict(verdict, gate);
    }

    phases.push(
      phaseStat("judge", round, judgeStart, verdict.model, verdict.usage),
    );
    usage = mergeUsage(usage, verdict.usage);
    judgeRounds.push(verdict);

    // ── Router outcome (fire-and-forget) ──
    // Record what the router did this round and whether the work verified, so the
    // market router can learn each task class's live cost/accuracy curve. Also
    // fold this round's budget-escalation premium into the accumulator — both use
    // `routed.model` (the model that just ran), so they MUST run before the
    // escalation below bumps `routed` for the next round.
    {
      // Executed-evidence "tests passed" signal (a failing repro later flipped
      // to passing). Wins over the judge for the verification source, per spec.
      const testsGreen = tracker.state() === "flipped";
      const deterministicVerdict =
        verdict.model.startsWith("deterministic/") ||
        verdict.model.startsWith("ladder/");
      const verificationSource: RouteOutcome["verificationSource"] = testsGreen
        ? "tests"
        : deterministicVerdict
          ? "completion"
          : "judge";
      const verified = testsGreen || verdict.complete;
      const score = testsGreen
        ? 1
        : Math.max(0, Math.min(1, verdict.confidence / 100));
      if (opts.onRouteOutcome) {
        const outcome: RouteOutcome = {
          taskClass: routed.taskClass,
          signatureHash: hashSignature(evaluation.refinedPrompt),
          model: routed.model,
          tier: routed.tier,
          verified,
          verificationSource,
          score,
          costUsdMicros: Math.round(execUsage.costUsd * 1_000_000),
          latencyMs: Date.now() - execStart,
          routingMode: routed.routingMode,
          round,
        };
        // A telemetry hook must never throw into the turn — defer into a
        // microtask so a SYNCHRONOUS throw is caught too, not just a rejection.
        const hook = opts.onRouteOutcome;
        void Promise.resolve()
          .then(() => hook(outcome))
          .catch(() => {});
      }
      if (opts.budgetGuard && routed.model !== initialWorkerModel) {
        const f = escalationFactor({
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
        });
        budgetEscalationPremium.inputTokens +=
          (f - 1) * (result.usage.inputTokens ?? 0);
        budgetEscalationPremium.outputTokens +=
          (f - 1) * (result.usage.outputTokens ?? 0);
        budgetEscalationPremium.cachedInputTokens +=
          (f - 1) * (result.usage.cachedInputTokens ?? 0);
      }
    }

    // Don't spend a full execute+judge round on a low-confidence
    // "incomplete" verdict. `confidence` is the judge's confidence IN its
    // verdict, so a low value on an "incomplete" call is a coin-flip that leans
    // complete — revising it doubles turn cost for marginal expected gain.
    // Confident-incomplete verdicts still revise. Tune/disable via
    // OXAGEN_REVISE_MIN_CONFIDENCE (default 40; 0 restores always-revise).
    // An unparsable value falls back to the default rather than becoming NaN —
    // a NaN floor would fail every `confidence >= floor` comparison and silently
    // switch auto-revision OFF, the opposite of the safe default.
    const reviseMinConfidenceEnv = Number(
      process.env["OXAGEN_REVISE_MIN_CONFIDENCE"],
    );
    const reviseMinConfidence =
      process.env["OXAGEN_REVISE_MIN_CONFIDENCE"] !== undefined &&
      Number.isFinite(reviseMinConfidenceEnv) &&
      reviseMinConfidenceEnv >= 0
        ? reviseMinConfidenceEnv
        : 40;
    const canRevise =
      !verdict.complete &&
      round < maxRounds &&
      !opts.readOnly &&
      !opts.signal?.aborted &&
      verdict.confidence >= reviseMinConfidence;
    if (!canRevise) break;
    prompt = buildRevisionPrompt(verdict);

    // ── Market-router tier escalation ──
    // enforce mode + escalateOnRejection and the judge rejected this round →
    // spend up one tier for the NEXT revision round (unless a model is pinned, or
    // we're already at the precise ceiling). runSegment reads `routed.model` at
    // call time, so mutating it here escalates the next round's worker.
    if (
      routed.routingMode === "enforce" &&
      opts.routingPolicy?.escalateOnRejection &&
      !opts.model &&
      routed.tier !== "precise"
    ) {
      const nextTier = escalateTier(routed.tier);
      if (nextTier !== routed.tier) {
        routed.tier = nextTier;
        routed.model = modelForTier(nextTier);
        routed.rationale = `${routed.rationale} · escalated to ${tierLabel(nextTier)} after judge rejection (round ${round + 1})`;
        opts.onStage?.({
          kind: "route",
          label: `escalated · ${tierLabel(nextTier)} (${routed.model.split("/").pop()})`,
          detail: "judge rejected — market router spending up one tier",
        });
      }
    }
  }

  const finalComplete = judgeRounds[judgeRounds.length - 1]?.complete ?? true;
  opts.onStage?.({
    kind: "complete",
    label: finalComplete ? "turn complete" : "turn finished (gaps remain)",
  });

  const trace = assembleTrace({
    cwd,
    originalPrompt: opts.prompt,
    evaluation,
    enhancement,
    routed,
    response: lastText,
    filesTouched: [...filesTouched],
    commandsRun,
    judgeRounds,
    finalComplete,
    steps: totalSteps,
    usage,
    startedAt,
    verbose: opts.verbose,
    phases,
    toolEvents,
    thinkingLog,
    mutationGates,
  });

  // Turn-end batch release (docs/specs/agent-file-locking/plan.md §5): every
  // Postgres lease this turn's lockContext.executionId holds is released
  // here, as a backstop alongside the per-call release in tools.ts —
  // covering a lock that leaked because a tool call didn't reach its own
  // `finally` (e.g. the turn was aborted between rounds). Fire-and-forget,
  // A throwing release must never
  // fail the turn — the lock's own TTL is the ultimate backstop — but the
  // failure is surfaced through `onError` rather than swallowed.
  if (opts.fileLock && lockContext) {
    void Promise.resolve(
      opts.fileLock.releaseAll(lockContext.executionId),
    ).catch((error: unknown) =>
      opts.onError?.({ phase: "file-lock-release", error }),
    );
  }

  // Record a lesson when the judge had to send the agent back (a gotcha).
  if (opts.memory && judgeRounds.length > 1) {
    const firstVerdict = judgeRounds[0];
    if (firstVerdict && firstVerdict.findings.length > 0) {
      void Promise.resolve(
        opts.memory.remember("gotcha", {
          lesson:
            `Work for "${truncate(opts.prompt, 80)}" was first judged incomplete: ` +
            truncate(firstVerdict.findings.join("; "), 200),
          files: [...filesTouched].slice(0, 5),
          outcome: finalComplete ? "success" : "failure",
        }),
      ).catch((error: unknown) =>
        opts.onError?.({ phase: "memory-remember", error }),
      );
    }
  }

  // Record trace.
  if (opts.trace) {
    void Promise.resolve(opts.trace.record(trace)).catch((error: unknown) =>
      opts.onError?.({ phase: "trace-record", error }),
    );
  }

  return {
    text: lastText,
    steps: totalSteps,
    messages: history,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens,
    },
    trace,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a {@link PhaseStat} from a start time (end is `now`) + its model/usage. */
function phaseStat(
  phase: PhaseStat["phase"],
  round: number,
  startedAt: number,
  model: string | undefined,
  usage: UsageTotals,
): PhaseStat {
  const finishedAt = Date.now();
  return {
    phase,
    round,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    model,
    usage,
  };
}

function enhancementSource(
  resolved: number,
  hasMemory: boolean,
): EnhancementTrace["source"] {
  if (resolved && hasMemory) return "code-graph+memory";
  if (resolved) return "code-graph";
  if (hasMemory) return "memory";
  return "none";
}

/** How the router settled a turn — `static` (deterministic), `shadow`, or `enforce`. */
type RoutingMode = "static" | "shadow" | "enforce";

interface RouteResult {
  model: string;
  tier: ModelTier;
  rationale: string;
  /** The task class this turn was routed for (recorded on every outcome). */
  taskClass: string;
  /** Which routing regime settled it — recorded on every outcome. */
  routingMode: RoutingMode;
}

/** One recorded routing outcome — emitted per (revise) round via `onRouteOutcome`. */
export interface RouteOutcome {
  taskClass: string;
  /** SHA-256 (hex) of the refined prompt — dedup / drift signal, PII-free. */
  signatureHash: string;
  model: string;
  tier: ModelTier;
  /** True when the round's work was verified (tests green, or judge complete). */
  verified: boolean;
  verificationSource: "tests" | "judge" | "eval" | "completion";
  /** Confidence / eval score in [0,1]. */
  score: number;
  costUsdMicros: number;
  latencyMs: number;
  routingMode: RoutingMode;
  /** The 0-based execute round this outcome is for. */
  round: number;
}

/**
 * Pick the executor (worker) model deterministically. A manual pin always wins.
 * Otherwise the Haiku evaluator is the authority — it already chose the cheapest
 * tier that does the job well. The deterministic router is consulted only as a
 * one-way SAFETY FLOOR. Returns just the base fields; {@link selectMarketModel}
 * decorates them with taskClass + routingMode.
 */
function selectModel(
  override: string | undefined,
  evaluation: PromptEvaluation,
): { model: string; tier: ModelTier; rationale: string } {
  if (override) {
    return {
      model: override,
      tier: tierForSlug(override),
      rationale: "pinned model",
    };
  }
  let tier = evaluation.recommendedTier;
  let rationale = `evaluator chose ${tierLabel(tier)} — cheapest tier for the job (complexity ${evaluation.complexity}/100)`;
  const floor = classifyTier({ text: evaluation.refinedPrompt });
  if (floor.tier === "precise" && TIER_RANK[tier] < TIER_RANK.precise) {
    tier = "precise";
    rationale = `safety floor raised to ${tierLabel(tier)} — ${floor.rationale}`;
  }
  return { model: modelForTier(tier), tier, rationale };
}

/**
 * Choose the worker model, honoring the Verified-Outcome Market Router policy.
 *
 *   - `off` / absent  → exactly today's deterministic {@link selectModel} result.
 *   - `shadow`        → today's routing runs, but the market decision is computed
 *                       and annotated onto the rationale (the outcome is recorded
 *                       for the model that ACTUALLY ran, so shadow learns without
 *                       changing behavior).
 *   - `enforce`       → the market decision picks the worker (a manual pin still
 *                       wins — decideMarketRoute honors `override`).
 *
 * The returned {@link RouteResult} carries the task class + routing mode so every
 * recorded outcome is stamped consistently.
 */
export function selectMarketModel(
  opts: RunTurnOptions,
  evaluation: PromptEvaluation,
): RouteResult {
  const signals = { text: evaluation.refinedPrompt };
  const taskClass = deriveTaskClass(signals);
  const deterministic = selectModel(opts.model, evaluation);
  const policy = opts.routingPolicy;
  const mode = policy?.mode ?? "off";

  if (policy && mode === "enforce") {
    const decision = decideMarketRoute({
      signals,
      taskClass,
      stats: opts.routingStats ?? [],
      policy,
      override: opts.model,
    });
    return {
      model: decision.model,
      tier: decision.tier,
      rationale: `[market:enforce] ${decision.rationale}`,
      taskClass,
      routingMode: "enforce",
    };
  }

  if (policy && mode === "shadow") {
    const decision = decideMarketRoute({
      signals,
      taskClass,
      stats: opts.routingStats ?? [],
      policy,
      override: opts.model,
    });
    // Keep today's routing; annotate what the market WOULD have chosen so a
    // shadow run is legible on the trace without altering behavior.
    return {
      model: deterministic.model,
      tier: deterministic.tier,
      rationale: `${deterministic.rationale} · [market:shadow → would pick ${decision.model.split("/").pop()} (${decision.source})]`,
      taskClass,
      routingMode: "shadow",
    };
  }

  return {
    model: deterministic.model,
    tier: deterministic.tier,
    rationale: deterministic.rationale,
    taskClass,
    routingMode: "static",
  };
}

/** SHA-256 (hex) of a prompt — the PII-free signature stamped on router outcomes. */
function hashSignature(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Count real changed lines in a unified diff (ignores +++/--- file headers). Exported for tests. */
export function diffChangedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---")
    ) {
      n++;
    }
  }
  return n;
}

/**
 * Perf: complexity-tier the completeness judge. An explicitly configured judge
 * model (`OXAGEN_LLM_ADVISOR`, or a panel via `judgeModels`/`OXAGEN_JUDGE_PANEL`)
 * ALWAYS wins — this only fills the DEFAULT judge for a single-judge turn. A
 * low-complexity, small-diff turn is a bounded check that the fast tier clears,
 * so reserve the balanced/precise default for higher blast-radius work. Returns
 * an `advisorModel` to pass through, or `undefined` to fall through to
 * `pickAdvisorModel` (the balanced default). Never returns the executor's own
 * model (that would be self-grading). Opt out by setting the complexity ceiling
 * to 0 via `OXAGEN_JUDGE_FAST_COMPLEXITY_MAX=0`.
 */
export function pickTieredAdvisor(
  executorModel: string,
  complexity: number,
  diffLines: number,
): string | undefined {
  if (process.env["OXAGEN_LLM_ADVISOR"]) return undefined; // explicit judge model wins
  const complexityCeiling = Number(
    process.env["OXAGEN_JUDGE_FAST_COMPLEXITY_MAX"] ?? 35,
  );
  const diffCeiling = Number(process.env["OXAGEN_DIFF_BUDGET"] ?? 120);
  // A non-positive ceiling opts out entirely (a complexity of exactly 0 would
  // otherwise still satisfy `0 <= 0`).
  if (
    complexityCeiling > 0 &&
    complexity <= complexityCeiling &&
    diffLines <= diffCeiling
  ) {
    const fast = modelForTier("fast");
    if (fast !== executorModel) return fast;
  }
  return undefined;
}

interface AssembleArgs {
  cwd: string;
  originalPrompt: string;
  evaluation: PromptEvaluation;
  enhancement: EnhancementTrace;
  routed: RouteResult;
  response: string;
  filesTouched: string[];
  commandsRun: string[];
  judgeRounds: JudgeVerdict[];
  finalComplete: boolean;
  steps: number;
  usage: UsageTotals;
  startedAt: number;
  verbose?: boolean;
  phases?: PhaseStat[];
  toolEvents?: ToolEvent[];
  thinkingLog?: Array<{ round: number; text: string }>;
  mutationGates?: MutationGateResult[];
}

function assembleTrace(a: AssembleArgs): TurnTrace {
  // Persist the reasoning per round, truncated for storage (each round capped;
  // at most the last 8 rounds retained). Always stored when present — the
  // thinking log is useful outside verbose mode too (it's what `/replay` shows
  // and what a memory-distiller mines).
  const thinking = (a.thinkingLog ?? [])
    .filter((t) => t.text.trim())
    .slice(-8)
    .map((t) => ({ round: t.round, text: truncate(t.text, 6000) }));
  return {
    id: newTraceId(),
    createdAt: a.startedAt,
    cwd: a.cwd,
    originalPrompt: a.originalPrompt,
    evaluation: {
      ...a.evaluation,
      refinedPrompt: truncate(a.evaluation.refinedPrompt, 4000),
    },
    enhancement: {
      ...a.enhancement,
      prompt: truncate(a.enhancement.prompt, 8000),
      context: truncate(a.enhancement.context, 8000),
    },
    selectedModel: a.routed.model,
    selectedTier: a.routed.tier,
    selectionRationale: a.routed.rationale,
    response: truncate(a.response, 4000),
    filesTouched: a.filesTouched,
    commandsRun: a.commandsRun,
    judgeRounds: a.judgeRounds.map((v) => ({
      ...v,
      reasoning: truncate(v.reasoning, 2000),
    })),
    finalComplete: a.finalComplete,
    steps: a.steps,
    usage: a.usage,
    durationMs: Date.now() - a.startedAt,
    ...(a.mutationGates && a.mutationGates.length > 0
      ? { mutationGates: a.mutationGates }
      : {}),
    ...(thinking.length > 0 ? { thinkingLog: thinking } : {}),
    ...(a.verbose
      ? {
          verbose: true,
          phases: a.phases,
          toolEvents: (a.toolEvents ?? []).slice(-200),
        }
      : {}),
  };
}

/** Bare execution path: no eval/enhance/judge, but still traced for `/replay`. */
async function runBare(
  opts: RunTurnOptions,
  cwd: string,
  startedAt: number,
  filesTouched: Set<string>,
  commandsRun: string[],
  onToolCall: (name: string, input: unknown) => void,
  phases: PhaseStat[],
  toolEvents: ToolEvent[],
  thinkingLog: Array<{ round: number; text: string }>,
): Promise<RunTurnResult> {
  // Bare mode has no full router, but an unpinned bare turn should still not
  // hard-default to the frontier tier (DEFAULT_AGENT_MODEL) — a trivial "explain
  // this file" would pay Fable pricing for nothing. Perf #8: route the unpinned
  // case through the deterministic `classifyTier` floor (the same cheap,
  // model-free classifier the full pipeline uses), so trivial bare turns run
  // cheap while auth/billing/architecture prompts still escalate to precise. A
  // pin (`opts.model`) always wins. This value BOTH labels the run (usage,
  // trace.selectedModel) AND is passed to runCodingAgent below, so the label can
  // never diverge from what actually executes.
  const model =
    opts.model ?? modelForTier(classifyTier({ text: opts.prompt }).tier);
  opts.onStage?.({ kind: "execute", label: "executing (pipeline off)" });
  const execStart = Date.now();
  let bareReasoning = "";
  // Agent file locking (docs/specs/agent-file-locking/plan.md): same one-id-
  // per-turn shape as the full pipeline path above — bare mode is its own
  // single-round "turn", so it gets its own lock identity.
  const bareLockId = newTraceId();
  const lockContext = opts.fileLock
    ? { agentId: bareLockId, executionId: bareLockId }
    : undefined;
  const result = await runCodingAgent({
    workspace: opts.workspace,
    ai: opts.ai,
    instruction: opts.prompt,
    images: opts.images,
    // Routed above (pin wins, else classifyTier floor) — pass it explicitly so
    // execution matches the labeled model instead of falling to runCodingAgent's
    // frontier DEFAULT_AGENT_MODEL.
    model,
    effort: opts.effort,
    system: composeAgentSystem(opts, cwd),
    history: opts.history,
    maxSteps: opts.maxSteps,
    extraTools: opts.extraTools,
    wrapTools: opts.wrapTools,
    readOnly: opts.readOnly,
    codeGraph: opts.codeGraph ?? undefined,
    askUser: opts.askUser ?? undefined,
    memory: opts.memory ?? undefined,
    onError: opts.onError,
    signal: opts.signal,
    // Bare path is a single execution round, so the caller's guard sees the
    // whole turn's usage directly — no cross-round baseline wrapping needed.
    budgetGuard: opts.budgetGuard,
    fileLock: opts.fileLock,
    lockContext,
    onEvent: (e) => {
      if (e.type === "text") opts.onText?.(e.delta);
      if (e.type === "reasoning") {
        opts.onReasoning?.(e.delta);
        bareReasoning += e.delta;
      }
      if (e.type === "tool-call") onToolCall(e.name, e.input);
      if (e.type === "tool-result")
        opts.onToolEvent?.({
          name: e.name,
          ok: e.ok,
          durationMs: e.durationMs,
        });
      if (e.type === "file-edit")
        opts.onFileEdit?.({
          path: e.path,
          kind: e.kind,
          bytes: e.bytes,
          beforeHash: e.beforeHash,
          afterHash: e.afterHash,
          newDiagnostics: e.newDiagnostics,
          declaredBreaking: e.declaredBreaking,
          replacements: e.replacements,
        });
      if (e.type === "final-diff") opts.onFileChange?.(e.diff, e.changedFiles);
      captureToolEvent(e, toolEvents, opts.verbose);
    },
  });
  if (bareReasoning.trim()) thinkingLog.push({ round: 0, text: bareReasoning });
  const usage = accumulateUsage(emptyUsage(), model, result.usage);
  phases.push(phaseStat("execute", 0, execStart, model, usage));

  // Union git-diff file list into filesTouched — ground truth for changed files,
  // supplements tool-call events in bare mode.
  for (const f of result.changedFiles) filesTouched.add(f);

  // Bare mode has no judge loop, so emit the terminal `complete` stage here so
  // the UI's turn lifecycle closes identically to the full-pipeline path (which
  // fires `complete` after the judge). Bare work is always considered complete.
  opts.onStage?.({ kind: "complete", label: "turn complete" });

  const evaluation: PromptEvaluation = {
    completeness: 0,
    complexity: 0,
    recommendedTier: tierForSlug(model),
    missing: [],
    contextQueries: [],
    refinedPrompt: opts.prompt,
    removed: [],
    reasoning: "Pipeline disabled (bare mode).",
    fallback: true,
    model,
    usage: emptyUsage(),
  };
  const trace = assembleTrace({
    cwd,
    originalPrompt: opts.prompt,
    evaluation,
    enhancement: {
      prompt: opts.prompt,
      context: "",
      resolved: [],
      lessonCount: 0,
      source: "none",
    },
    routed: {
      model,
      tier: tierForSlug(model),
      rationale: "bare mode (no routing)",
      taskClass: deriveTaskClass({ text: opts.prompt }),
      routingMode: "static",
    },
    response: result.text,
    filesTouched: [...filesTouched],
    commandsRun,
    judgeRounds: [],
    finalComplete: true,
    steps: result.steps,
    usage,
    startedAt,
    verbose: opts.verbose,
    phases,
    toolEvents,
    thinkingLog,
  });

  // Turn-end batch release — see the full-pipeline path's identical block above.
  if (opts.fileLock && lockContext) {
    void Promise.resolve(
      opts.fileLock.releaseAll(lockContext.executionId),
    ).catch((error: unknown) =>
      opts.onError?.({ phase: "file-lock-release", error }),
    );
  }

  if (opts.trace) {
    void Promise.resolve(opts.trace.record(trace)).catch((error: unknown) =>
      opts.onError?.({ phase: "trace-record", error }),
    );
  }

  return {
    text: result.text,
    steps: result.steps,
    messages: result.messages,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
    },
    trace,
  };
}
