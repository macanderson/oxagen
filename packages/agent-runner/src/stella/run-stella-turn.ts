/**
 * Run one turn on the Stella engine, satisfying the exact contract
 * `runCodingAgent` satisfies.
 *
 * Same options in (`RunCodingAgentOptions`), same result out
 * (`RunCodingAgentResult`), same `onEvent` / `onStreamPart` streams — which is
 * what lets Phase C land with **no surface changes at all**. Every caller
 * already goes through `executeTurn`; the branch happens there and nothing
 * above it can tell which engine ran.
 *
 * ## Who owns what
 *
 * | Concern | Owner under Stella |
 * |---|---|
 * | The step loop, compaction, retry, loop detection, dispatch order | the engine |
 * | Every model call — routing, BYOK, metering, `token_usage` | the host, via `AgentAi` |
 * | Every tool call — permissions, kernel `invoke()`, file locks, edit gate | the host, via the `ToolSet` |
 * | The transcript during the turn | the engine |
 * | The durable record of the turn | the host (`agent_run_events`) |
 *
 * The middle two rows are the point: moving the loop into Rust moves no
 * enforcement point. Every effect the engine wants re-enters oxagen through a
 * port it already had.
 *
 * ## What the host does up front instead of mid-turn
 *
 * `MemoryProvider.recallContext()` is called **once, before the turn opens**,
 * and the recalled text rides as a volatile user message immediately before the
 * instruction — byte-identical placement to the TS loop's, and for the same
 * prompt-cache reason. There is no mid-turn `recallContext()` callback for the
 * engine to make, which is the change macanderson/oxagen#1236 and #1246 are
 * waiting on: their `MemoryProvider`-shaped adapters have no caller left on
 * this path.
 */
import {
  buildWorkspaceTools,
  changedFilesFromDiff,
  wrapToolsWithSpeculation,
  DEFAULT_MAX_AGENT_STEPS,
  type CodingEvent,
  type RunCodingAgentOptions,
  type RunCodingAgentResult,
} from "@oxagen/agent-engine";
import type { ModelMessage, ToolSet } from "ai";
import type {
  CompletionUsage,
  TurnRequest,
} from "@oxagen/stella-engine-client";
import { createEventMapper } from "./event-mapping";
import {
  toCompletionMessages,
  toModelMessages,
  UnsupportedTurnContentError,
} from "./message-mapping";
import {
  createProviderHandler,
  type CompletionPricer,
} from "./provider-bridge";
import type { SidecarLease } from "./sidecar-pool";
import {
  executeToolRequest,
  mutatingToolSet,
  toModelToolSet,
  toToolSchemas,
} from "./tool-mapping";

/** The engine ended the turn without completing it, for a reason the host must surface. */
export class StellaTurnAbortedError extends Error {
  constructor(
    readonly reason: string,
    readonly costUsd: number,
  ) {
    super(`the Stella engine aborted the turn: ${reason}`);
    this.name = "StellaTurnAbortedError";
  }
}

export interface StellaTurnDeps {
  /** An exclusively-held sidecar for the duration of this turn. */
  lease: SidecarLease;
  /**
   * Prices a completion for the engine's own budget accounting. Omitted ⇒ the
   * engine is told every call cost zero, so no Stella-side budget is armed —
   * see {@link buildBudgetSpec}. Host-side metering is unaffected either way.
   */
  price?: CompletionPricer;
}

/**
 * The default system prompt, resolved by the caller.
 *
 * `runCodingAgent` falls back to `buildCodingCorePrompt()` when `system` is
 * omitted. That default is not exported, and re-deriving it here would create a
 * second copy of a prompt whose byte-stability is a caching contract — so this
 * path requires the caller to have resolved one. `executeTurn` does.
 */
export const MISSING_SYSTEM_PROMPT =
  "the Stella engine path requires an explicit `system` prompt";

export async function runStellaTurn(
  opts: RunCodingAgentOptions,
  deps: StellaTurnDeps,
): Promise<RunCodingAgentResult> {
  assertRepresentable(opts);
  if (!opts.system)
    throw new UnsupportedTurnContentError(
      "a turn with no system prompt",
      MISSING_SYSTEM_PROMPT,
    );

  const onEvent = opts.onEvent ?? ((): void => undefined);
  const tools = buildToolSet(opts);
  const mutating = mutatingToolSet(opts.mutatingToolNames);

  const recalled = await recallOnce(opts);
  const history: ModelMessage[] = [
    ...(opts.history ?? []),
    // The volatile recalled-memory message, placed exactly where the TS loop
    // places it: AFTER the cached system block, immediately before the
    // instruction, and as `user` rather than `system` so the platform's LLM
    // route does not hoist it back into the cached prefix.
    ...(recalled ? [{ role: "user" as const, content: recalled }] : []),
  ];

  const usageTotals: CompletionUsage[] = [];
  const mapper = createEventMapper();
  // The engine owns the transcript while the turn runs and hands the whole
  // conversation back on every `provider_request`. Keeping the last one is how
  // the host reconstructs `RunCodingAgentResult.messages` without maintaining a
  // parallel copy that could disagree with what the model actually saw.
  let lastSeenTranscript: ModelMessage[] | undefined;
  let steps = 0;

  const request: TurnRequest = {
    provider_id: "oxagen-host",
    tools: await toToolSchemas(tools, mutating),
    messages: toCompletionMessages({
      system: opts.system,
      history,
      instruction: opts.instruction,
    }),
    budget: buildBudgetSpec(deps.price !== undefined),
    max_steps: opts.maxSteps ?? DEFAULT_MAX_AGENT_STEPS,
  };

  const provider = createProviderHandler({
    ai: opts.ai,
    model: opts.model ?? "",
    system: opts.system,
    tools: toModelToolSet(tools),
    effort: opts.effort,
    signal: opts.signal,
    onStreamPart: opts.onStreamPart,
    price: deps.price,
    onUsage: (usage) => usageTotals.push(usage),
  });

  const run = await deps.lease.client.runTurn(request, {
    // A production host reports reverse-request failures to the engine rather
    // than throwing: a transport blip is something the engine retries, and a
    // failed tool is something the model is meant to read and react to.
    onFailure: "report",
    onProviderRequest: async (completion) => {
      steps += 1;
      lastSeenTranscript = toModelMessages(completion.messages);
      return provider(completion);
    },
    onToolRequest: (name, input) =>
      executeToolRequest(tools, name, input, {
        // The engine keys its own parking on `request_id`; the tool set only
        // needs a stable id per call for its own logging and hooks.
        toolCallId: `stella-${name}-${mapper.toolCallCount}`,
        signal: opts.signal,
      }),
    onEvent: (event) => {
      // The raw frame first and unconditionally — it is the high-fidelity
      // record, and the `CodingEvent` below is a lossy projection of it.
      opts.onStreamPart?.(event);
      const mapped = mapper.map(event);
      if (mapped) onEvent(mapped);
    },
  });

  if (run.outcome.status === "aborted") {
    const stopReason = stopReasonFor(run.outcome.reason);
    if (!stopReason) {
      throw new StellaTurnAbortedError(
        run.outcome.reason,
        run.outcome.cost_usd,
      );
    }
    return assembleResult({
      text: "",
      steps,
      opts,
      onEvent,
      usageTotals,
      transcript: lastSeenTranscript,
      stopReason,
    });
  }

  return assembleResult({
    text: run.outcome.text,
    steps,
    opts,
    onEvent,
    usageTotals,
    transcript: lastSeenTranscript,
  });
}

/**
 * Assemble tools exactly as `runCodingAgent` does — with one deliberate
 * omission.
 *
 * `wrapToolsWithDispatchGuard` is **not** applied. Stella partitions a step's
 * calls itself on the `read_only` bit each schema carries, so running the TS
 * barrier underneath would serialize a second time against a decision the
 * engine has already made — the mutating tool would hold the host-side FIFO
 * while the engine believed it was free to dispatch the next call. The guard
 * was always described as an interim stand-in for exactly this; under Stella
 * the engine is the version it was standing in for.
 *
 * Everything else keeps the engine's own ordering and its reasons: extras
 * merge before wrapping so an MCP tool is covered too, speculation sits under
 * the caller's wrapper so the permission gate still sees every real call, and
 * `wrapTools` is last so it wraps all of it.
 */
function buildToolSet(opts: RunCodingAgentOptions): ToolSet {
  let tools: ToolSet = opts.workspace
    ? buildWorkspaceTools(opts.workspace, {
        readOnly: opts.readOnly,
        codeGraph: opts.codeGraph,
        onEvent: opts.onEvent ?? ((): void => undefined),
        signal: opts.signal,
        fileLock: opts.fileLock,
        lockContext: opts.lockContext,
        diagnostics: opts.diagnostics,
        askUser: opts.askUser,
      })
    : ({} as ToolSet);

  if (opts.extraTools) tools = { ...tools, ...opts.extraTools };

  const speculativeEnabled =
    opts.speculativeTools ??
    (process.env["OXAGEN_SPECULATIVE_TOOLS"] !== "0" &&
      process.env["OXAGEN_SPECULATIVE_TOOLS"] !== "false");
  if (opts.workspace && speculativeEnabled) {
    tools = wrapToolsWithSpeculation(tools, {
      onStats: opts.onSpeculationStats,
    });
  }

  if (opts.wrapTools) tools = opts.wrapTools(tools);
  return tools;
}

/**
 * Arm the engine's own budget only when the host can price a call.
 *
 * `CompletionResult.cost_usd` is what the engine folds into a turn's settled
 * spend. With no pricer every call reports zero, so an `enforced` ceiling could
 * never be reached — a guard that cannot fire, which reads as protection and is
 * not. `observed` records the same zeroes without pretending to enforce.
 *
 * This is separate from `RunCodingAgentOptions.budgetGuard`, which the host
 * still owns and which is unaffected by the engine choice.
 */
export function buildBudgetSpec(hasPricer: boolean): TurnRequest["budget"] {
  return { mode: hasPricer ? "observed" : "off" };
}

/**
 * Map the engine's abort reason onto the host's `TurnStopReason`.
 *
 * Returns `undefined` for a reason that is not an orderly stop, which the
 * caller turns into a thrown error. An abort the host cannot name must not be
 * reported as a completed turn with empty text — that is the shape of failure
 * that looks like success in every downstream row.
 */
export function stopReasonFor(
  reason: string,
): RunCodingAgentResult["stopReason"] | undefined {
  const lowered = reason.toLowerCase();
  if (lowered.includes("budget")) return "budget";
  if (lowered.includes("max step") || lowered.includes("max_step")) {
    return "max-steps";
  }
  if (lowered.includes("step limit") || lowered.includes("step_limit")) {
    return "max-steps";
  }
  return undefined;
}

async function recallOnce(opts: RunCodingAgentOptions): Promise<string> {
  if (!opts.memory) return "";
  try {
    return await opts.memory.recallContext();
  } catch (error) {
    // Same contract as the TS loop: a recall failure degrades the turn to no
    // recalled context and is surfaced, never swallowed.
    opts.onError?.({ phase: "memory-recall", error });
    return "";
  }
}

async function assembleResult(args: {
  text: string;
  steps: number;
  opts: RunCodingAgentOptions;
  onEvent: (event: CodingEvent) => void;
  usageTotals: readonly CompletionUsage[];
  transcript?: ModelMessage[];
  stopReason?: RunCodingAgentResult["stopReason"];
}): Promise<RunCodingAgentResult> {
  const { opts, onEvent } = args;

  let diff = "";
  let changedFiles: string[] = [];
  if (opts.workspace) {
    diff = await opts.workspace.diff();
    changedFiles = changedFilesFromDiff(diff);
    onEvent({ type: "final-diff", diff, changedFiles });
  }

  const messages: ModelMessage[] = [
    ...(args.transcript ?? []),
    ...(args.text ? [{ role: "assistant" as const, content: args.text }] : []),
  ];

  return {
    text: args.text,
    steps: args.steps,
    diff,
    changedFiles,
    usage: sumUsage(args.usageTotals),
    messages,
    ...(args.stopReason ? { stopReason: args.stopReason } : {}),
  };
}

/**
 * Total the host's own per-call usage.
 *
 * Summed from what the host's model adapter reported, never from the engine's
 * `StepUsage` frames — §3 of the plan: the host makes every call, so the host
 * is the source of truth for what those calls cost, and the engine's frames are
 * a cross-check.
 */
export function sumUsage(
  usages: readonly CompletionUsage[],
): RunCodingAgentResult["usage"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawCached = false;
  for (const usage of usages) {
    inputTokens += usage.input_tokens;
    outputTokens += usage.output_tokens;
    if (usage.cached_input_tokens !== undefined) {
      cachedInputTokens += usage.cached_input_tokens;
      sawCached = true;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(sawCached ? { cachedInputTokens } : {}),
  };
}

/**
 * Refuse a turn carrying something this path would silently drop.
 *
 * Images and videos have no verified `CompletionMessage.attachments` spelling,
 * and a model answering confidently about an attachment it never received is
 * the capability loss §5 exists to prevent. Refusing routes the turn to the TS
 * engine instead of degrading it.
 */
function assertRepresentable(opts: RunCodingAgentOptions): void {
  if (opts.images && opts.images.length > 0) {
    throw new UnsupportedTurnContentError(
      "image attachments",
      "Stella's attachment wire shape is unverified against a running sidecar",
    );
  }
  if (opts.videos && opts.videos.length > 0) {
    throw new UnsupportedTurnContentError(
      "video attachments",
      "Stella's attachment wire shape is unverified against a running sidecar",
    );
  }
}
