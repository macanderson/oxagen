/**
 * The turn pipeline — what every user prompt flows through.
 *
 * This is the orchestrator that makes `oxagen` excellent at context and honest
 * about completion. For each prompt it:
 *
 *   1. EVALUATE — a cheap model scores completeness + complexity and proposes
 *      context to pull and a noise-removed rewrite.
 *   2. ENHANCE  — the code graph + recalled lessons are injected, grounding the
 *      agent in the real files/symbols involved.
 *   3. ROUTE    — the cheapest sufficient model is selected (evaluator's
 *      recommendation reconciled UP with the deterministic cost router).
 *   4. EXECUTE  — the coding agent runs the local tool loop.
 *   5. JUDGE    — a DIFFERENT model checks whether the work is actually complete.
 *   6. REVISE   — if it isn't, the agent is sent back with the judge's findings,
 *      then re-judged, up to a bounded number of rounds.
 *
 * Every stage emits a {@link StageEvent} so the REPL can show the process live,
 * and the whole thing is recorded as a {@link TurnTrace} for `/replay`. The
 * pipeline degrades gracefully: any evaluator/judge model failure falls back to a
 * heuristic, so a turn always runs.
 */
import type { ModelMessage } from "ai";
import { runAgent } from "./loop.js";
import { ensureGatewayKey, MissingGatewayKeyError } from "./env.js";
import { evaluatePrompt } from "./evaluator.js";
import { judgeCompleteness, buildRevisionPrompt } from "./judge.js";
import { enhancePrompt } from "./prompt-enhancer.js";
import {
  classifyTier,
  modelForTier,
  tierForSlug,
  tierLabel,
  accumulateUsage,
} from "./model-router.js";
import { emptyUsage, type ModelTier, type UsageTotals } from "./fleet/types.js";
import type { ProjectContext } from "./project-context.js";
import type { SessionMemory } from "./memory.js";
import type { FleetMemory } from "./fleet/memory.js";
import type {
  EnhancementTrace,
  JudgeVerdict,
  PhaseStat,
  PromptEvaluation,
  StageEvent,
  ToolEvent,
  TurnTrace,
} from "./trace.js";

export { MissingGatewayKeyError };

const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, precise: 2 };
function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Cap stored free-text so a single trace file can't grow without bound. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

let traceCounter = 0;
function newTraceId(): string {
  traceCounter = (traceCounter + 1) % 1_000_000;
  return `turn_${Date.now().toString(36)}_${traceCounter.toString(36)}`;
}

export interface RunTurnOptions {
  /** The user's prompt for this turn, exactly as typed. */
  prompt: string;
  /** Working directory the agent operates on (default: process.cwd()). */
  cwd?: string;
  /** Prior conversation messages (for multi-turn REPL sessions). */
  history?: ModelMessage[];
  /** Manual model override — pins the executor and skips auto-routing. */
  model?: string;
  /** Max tool-loop steps per execution round (default 32). */
  maxSteps?: number;
  /** Loaded project rules (CLAUDE.md/AGENTS.md). */
  projectContext?: ProjectContext;
  /** Read-only mode: no file mutation, and the auto-revise loop is disabled. */
  readOnly?: boolean;
  /** Episodic session memory (recalled before, written after). */
  memory?: SessionMemory | null;
  /** Fleet memory for recalling/recording weighted lessons. */
  fleetMemory?: FleetMemory | null;
  /** Max judge→revise rounds (default 1; 0 disables auto-revision). */
  maxReviseRounds?: number;
  /** Skip the eval/enhance/judge pipeline and run the bare agent. */
  bare?: boolean;
  /**
   * Capture full per-phase telemetry (timing, per-model token/cost breakdown,
   * tool calls + results, the injected context) onto the trace, for `/verbose`.
   */
  verbose?: boolean;
  /** Abort the turn (e.g. user hit Ctrl-C / Esc). */
  signal?: AbortSignal;
  /** Live stage events for the UI. */
  onStage?: (e: StageEvent) => void;
  /** Streamed assistant text deltas. */
  onText?: (delta: string) => void;
  /** Fired when the model invokes a tool. */
  onToolCall?: (name: string, input: unknown) => void;
}

export interface RunTurnResult {
  /** The agent's final assistant text (last execution round). */
  text: string;
  /** Tool-loop steps across all execution rounds. */
  steps: number;
  /** Full message history including this turn's assistant/tool messages. */
  messages: ModelMessage[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
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
  const obj = (input ?? {}) as { path?: unknown; command?: unknown; cmd?: unknown };
  if ((name === "write_file" || name === "edit_file") && typeof obj.path === "string") {
    files.add(obj.path);
  }
  if (name === "bash") {
    const cmd = obj.command ?? obj.cmd;
    if (typeof cmd === "string") commands.push(truncate(cmd, 120));
  }
}

/**
 * Run one prompt through the full pipeline. Throws {@link MissingGatewayKeyError}
 * if no gateway credential can be resolved; otherwise always produces a trace.
 */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const cwd = opts.cwd ?? process.cwd();
  if (!ensureGatewayKey(cwd)) throw new MissingGatewayKeyError();

  const startedAt = Date.now();
  const filesTouched = new Set<string>();
  const commandsRun: string[] = [];
  const onToolCall = (name: string, input: unknown): void => {
    collectActivity(name, input, filesTouched, commandsRun);
    opts.onToolCall?.(name, input);
  };
  // Verbose telemetry accumulators (left empty/undefined when verbose is off).
  const phases: PhaseStat[] = [];
  const toolEvents: ToolEvent[] = [];
  const onToolEvent = opts.verbose ? (e: ToolEvent): void => void toolEvents.push(e) : undefined;

  // ── Bare mode: skip the pipeline, run the agent directly. ──
  if (opts.bare) {
    return runBare(opts, cwd, startedAt, filesTouched, commandsRun, onToolCall, onToolEvent, toolEvents);
  }

  let usage = emptyUsage();

  // ── 1. EVALUATE ──
  const evalStart = Date.now();
  const evaluation = await evaluatePrompt({ prompt: opts.prompt, signal: opts.signal });
  phases.push(phaseStat("evaluate", 0, evalStart, evaluation.model, evaluation.usage));
  usage = mergeUsage(usage, evaluation.usage);
  opts.onStage?.({
    kind: "evaluate",
    label: `evaluated · completeness ${evaluation.completeness}/100 · complexity ${evaluation.complexity}/100`,
    detail: evaluation.fallback ? "heuristic" : evaluation.model.split("/").pop(),
  });

  // ── 2. ENHANCE ──
  const enhanceStart = Date.now();
  const enhanced = await enhancePrompt({
    prompt: evaluation.refinedPrompt,
    cwd,
    memory: opts.fleetMemory ?? null,
    extraQueries: evaluation.contextQueries,
  });
  phases.push(phaseStat("enhance", 0, enhanceStart, undefined, emptyUsage()));
  const enhancement: EnhancementTrace = {
    prompt: enhanced.prompt,
    context: enhanced.context,
    resolved: enhanced.resolved,
    lessonCount: enhanced.lessons.length,
    source: enhancementSource(enhanced.resolved.length, enhanced.lessons.length),
    startedAt: enhanced.startedAt,
    finishedAt: enhanced.finishedAt,
    durationMs: enhanced.durationMs,
    retrieval: enhanced.retrieval,
  };
  opts.onStage?.({
    kind: "enhance",
    label:
      enhanced.resolved.length || enhanced.lessons.length
        ? `enhanced · ${enhanced.resolved.length} code refs · ${enhanced.lessons.length} lessons`
        : "enhanced · no extra context found",
  });

  // ── 3. ROUTE ──
  const routeStart = Date.now();
  const routed = selectModel(opts.model, evaluation);
  phases.push(phaseStat("route", 0, routeStart, undefined, emptyUsage()));
  opts.onStage?.({
    kind: "route",
    label: `model · ${tierLabel(routed.tier)} (${routed.model.split("/").pop()})`,
    detail: routed.rationale,
  });

  // ── 4. EXECUTE (+ 5. JUDGE / 6. REVISE loop) ──
  const maxRounds = Math.max(0, opts.maxReviseRounds ?? 1);
  const judgeRounds: JudgeVerdict[] = [];
  let history = opts.history ?? [];
  let prompt = enhanced.prompt;
  let lastText = "";
  let totalSteps = 0;

  for (let round = 0; ; round++) {
    if (round > 0) {
      opts.onStage?.({ kind: "revise", label: `revising · round ${round} (incomplete work)` });
    }
    opts.onStage?.({
      kind: "execute",
      label: round === 0 ? "executing" : `executing · revision ${round}`,
    });

    const execStart = Date.now();
    const result = await runAgent({
      prompt,
      history,
      cwd,
      model: routed.model,
      maxSteps: opts.maxSteps,
      projectContext: opts.projectContext,
      readOnly: opts.readOnly,
      memory: opts.memory,
      signal: opts.signal,
      onText: opts.onText,
      onToolCall,
      onToolEvent,
    });
    const execUsage = accumulateUsage(emptyUsage(), routed.model, result.usage);
    phases.push(phaseStat("execute", round, execStart, routed.model, execUsage));
    usage = mergeUsage(usage, execUsage);
    history = result.messages;
    lastText = result.text;
    totalSteps += result.steps;

    // ── 5. JUDGE ──
    const judgeStart = Date.now();
    const verdict = await judgeCompleteness({
      request: opts.prompt,
      response: result.text,
      filesTouched: [...filesTouched],
      commandsRun,
      steps: result.steps,
      executorModel: routed.model,
      signal: opts.signal,
    });
    phases.push(phaseStat("judge", round, judgeStart, verdict.model, verdict.usage));
    usage = mergeUsage(usage, verdict.usage);
    judgeRounds.push(verdict);
    opts.onStage?.({
      kind: "judge",
      label: verdict.complete
        ? `judged complete · ${verdict.confidence}% confident`
        : `judged INCOMPLETE · ${verdict.findings.length} gap(s)`,
      detail: `advisor: ${verdict.model.split("/").pop()}${verdict.fallback ? " (heuristic)" : ""}`,
    });

    const canRevise =
      !verdict.complete &&
      round < maxRounds &&
      !opts.readOnly &&
      !opts.signal?.aborted;
    if (!canRevise) break;
    prompt = buildRevisionPrompt(verdict);
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
  });
  recordLesson(opts.fleetMemory, trace);

  return {
    text: lastText,
    steps: totalSteps,
    messages: history,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    trace,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Build a {@link PhaseStat} from a start time (end is `now`) + its model/usage. */
function phaseStat(
  phase: PhaseStat["phase"],
  round: number,
  startedAt: number,
  model: string | undefined,
  usage: UsageTotals,
): PhaseStat {
  const finishedAt = Date.now();
  return { phase, round, startedAt, finishedAt, durationMs: finishedAt - startedAt, model, usage };
}

function enhancementSource(
  resolved: number,
  lessons: number,
): EnhancementTrace["source"] {
  if (resolved && lessons) return "code-graph+memory";
  if (resolved) return "code-graph";
  if (lessons) return "memory";
  return "none";
}

interface RouteResult {
  model: string;
  tier: ModelTier;
  rationale: string;
}

/** Pick the executor model: a manual pin wins; else evaluator ⟂ router (never under-spend). */
function selectModel(override: string | undefined, evaluation: PromptEvaluation): RouteResult {
  if (override) {
    return { model: override, tier: tierForSlug(override), rationale: "pinned model" };
  }
  const routed = classifyTier({ text: evaluation.refinedPrompt });
  const tier = maxTier(evaluation.recommendedTier, routed.tier);
  // The deterministic router only ever escalates above the evaluator on high-stakes
  // signals; when it does, its rationale is the honest reason we spent more.
  const routerEscalated = TIER_RANK[routed.tier] > TIER_RANK[evaluation.recommendedTier];
  const rationale = routerEscalated
    ? `router escalated — ${routed.rationale}`
    : `evaluator recommended (complexity ${evaluation.complexity}/100)`;
  return { model: modelForTier(tier), tier, rationale };
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
}

function assembleTrace(a: AssembleArgs): TurnTrace {
  return {
    id: newTraceId(),
    createdAt: a.startedAt,
    cwd: a.cwd,
    originalPrompt: a.originalPrompt,
    evaluation: { ...a.evaluation, refinedPrompt: truncate(a.evaluation.refinedPrompt, 4000) },
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
    judgeRounds: a.judgeRounds.map((v) => ({ ...v, reasoning: truncate(v.reasoning, 2000) })),
    finalComplete: a.finalComplete,
    steps: a.steps,
    usage: a.usage,
    durationMs: Date.now() - a.startedAt,
    // Verbose telemetry — only attached when the turn ran in verbose mode, so
    // non-verbose traces stay small. Tool events are capped to bound the file.
    ...(a.verbose
      ? {
          verbose: true,
          phases: a.phases,
          toolEvents: (a.toolEvents ?? []).slice(-200),
        }
      : {}),
  };
}

/**
 * Record a weighted lesson when a turn revealed something worth remembering:
 * the judge had to send the agent back (a gotcha) or it touched files (a routine
 * change). Best-effort and silent — memory must never break a turn.
 */
function recordLesson(memory: FleetMemory | null | undefined, trace: TurnTrace): void {
  if (!memory) return;
  const needsRevision = trace.judgeRounds.length > 1;
  if (!needsRevision && trace.filesTouched.length === 0) return;
  const firstVerdict = trace.judgeRounds[0];
  if (needsRevision && firstVerdict && firstVerdict.findings.length > 0) {
    memory.record({
      kind: "gotcha",
      weight: "high",
      lesson:
        `Work for "${truncate(trace.originalPrompt, 80)}" was first judged incomplete: ` +
        truncate(firstVerdict.findings.join("; "), 200),
      files: trace.filesTouched.slice(0, 5),
      outcome: trace.finalComplete ? "success" : "failure",
    });
  } else if (trace.filesTouched.length > 0) {
    memory.record({
      kind: "routine-change",
      weight: "low",
      lesson: `Changed ${trace.filesTouched.slice(0, 5).join(", ")} for "${truncate(trace.originalPrompt, 80)}".`,
      files: trace.filesTouched.slice(0, 5),
      outcome: trace.finalComplete ? "success" : "failure",
    });
  }
}

/** Bare execution path: no eval/enhance/judge, but still traced for `/replay`. */
async function runBare(
  opts: RunTurnOptions,
  cwd: string,
  startedAt: number,
  filesTouched: Set<string>,
  commandsRun: string[],
  onToolCall: (name: string, input: unknown) => void,
  onToolEvent: ((e: ToolEvent) => void) | undefined,
  toolEvents: ToolEvent[],
): Promise<RunTurnResult> {
  const model = opts.model ?? modelForTier("balanced");
  opts.onStage?.({ kind: "execute", label: "executing (pipeline off)" });
  const execStart = Date.now();
  const result = await runAgent({
    prompt: opts.prompt,
    history: opts.history,
    cwd,
    model: opts.model,
    maxSteps: opts.maxSteps,
    projectContext: opts.projectContext,
    readOnly: opts.readOnly,
    memory: opts.memory,
    signal: opts.signal,
    onText: opts.onText,
    onToolCall,
    onToolEvent,
  });
  const usage = accumulateUsage(emptyUsage(), model, result.usage);
  const phases: PhaseStat[] = [phaseStat("execute", 0, execStart, model, usage)];
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
    enhancement: { prompt: opts.prompt, context: "", resolved: [], lessonCount: 0, source: "none" },
    routed: { model, tier: tierForSlug(model), rationale: "bare mode (no routing)" },
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
  });
  return {
    text: result.text,
    steps: result.steps,
    messages: result.messages,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    trace,
  };
}
