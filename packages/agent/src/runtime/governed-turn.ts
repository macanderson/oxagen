/**
 * `runGovernedTurn` — the in-app governance agent's turn loop (ADR-043 §2).
 *
 * Oxagen governs agents; it does not run them. What is left of "running" is
 * this: ONE bounded, metered, tool-calling model turn whose tools are the
 * platform's own capability contracts, materialised by
 * `runtime/materialize-tools.ts` and dispatched through `kernel.invoke()` so
 * IAM → entitlement → tool RBAC → consent → approval → telemetry apply per
 * call. There is no sandbox, no file system, no browser, no subagent fan-out
 * and no background-task machinery underneath it, and none may be added.
 *
 * The loop deliberately owns almost nothing:
 *
 *   • It calls `streamAgentReply` from `@oxagen/ai` — the ONLY permitted LLM
 *     chokepoint, which meters tokens to ClickHouse, charges credits, hashes
 *     the prompt and tags the surface. Importing `streamText` from `ai` here
 *     would silently un-meter every chat turn.
 *   • It hands back the raw AI-SDK `fullStream` so each surface keeps its own
 *     published wire format (`apps/app`'s `translateAgentStream`, `apps/api`'s
 *     `createApiStreamTranslator`) with no translation layer in between.
 *   • Approval and consent pauses are NOT its business: a materialised tool
 *     blocks inside its own `execute` on `waitForApproval` and the surface has
 *     already been told through `materializeTools`'
 *     `onApprovalRequired`/`onConsentRequired` hooks. The loop's only duty is
 *     to keep streaming across that pause rather than tearing the turn down.
 *
 * What it DOES own is the two bounds a governed turn must never be without:
 * a hard step cap (`stopWhen: stepCountIs`) so an agentic tool loop cannot run
 * away, and — when the caller supplies one — the shared per-turn dollar guard
 * from `@oxagen/billing`, evaluated between steps off the same aggregated
 * usage the surface bills on.
 */

import {
  defaultModel,
  modelIdOf,
  stepCountIs,
  streamAgentReply,
  type EffortLevel,
  type ModelMessage,
  type StreamAgentReplyArgs,
  type Tool,
  type ToolSet,
} from "@oxagen/ai";
import { runInTenantScope } from "@oxagen/tenancy";

/**
 * Default hard ceiling on model steps in one turn. A governance answer is a
 * handful of reads plus a reply; twelve steps is generous for that and still
 * bounds the runaway case (the AI SDK's own default is `stepCountIs(1)`, which
 * would execute a tool and then never let the model read the result).
 */
export const DEFAULT_GOVERNED_TURN_MAX_STEPS = 12;

/**
 * A binary attachment carried into the turn as a multimodal message part.
 * `kind` decides the part shape: an image rides as an AI-SDK `image` part, and
 * anything else (video, and any future document type) as a `file` part — the
 * providers that accept video input take it that way.
 */
export interface GovernedTurnAttachment {
  kind: "image" | "file";
  /** Raw bytes. Never a data: URL — the byte payload never round-trips a client. */
  data: Uint8Array;
  /** IANA media type, e.g. "image/png", "video/mp4". */
  mediaType: string;
}

/** Cumulative token usage for the turn, in the shape every surface meters on. */
export interface GovernedTurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Prompt-cache reads — a subset of `inputTokens`, priced at the cached rate. */
  cachedInputTokens: number;
}

/**
 * Per-step budget guard, structurally the value `createTurnBudgetGuard`
 * (`@oxagen/billing`) returns. Spelled structurally rather than imported so the
 * agent runtime does not take a dependency on the billing package just to name
 * a callback; the two shapes are checked against each other at the call site.
 */
export type GovernedTurnBudgetGuard = (usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}) => Promise<"continue" | "stop"> | "continue" | "stop";

export interface GovernedTurnInput {
  /**
   * Org + workspace + surface + the UUID of the user message that opened the
   * turn. Forwarded verbatim to `streamAgentReply`, which writes it to
   * `token_usage` and charges credits against it — `messageId` MUST be a UUID.
   */
  telemetry: StreamAgentReplyArgs["telemetry"];
  /** Resolved language model. Omit to take the platform's balanced-tier default. */
  model?: StreamAgentReplyArgs["model"];
  /**
   * The fully-resolved system prompt: `buildChatSystemPrompt(ctx)` layered with
   * the bound agent's instructions and the workspace's prompt config through
   * `resolvePrompt`. Byte-stable across turns of a conversation so the
   * provider's prompt cache keeps hitting — volatile per-turn context belongs
   * in `contextMessages`, never here (ADR-021 §2).
   */
  system: string;
  /** Prior turns, chronological, EXCLUDING the current user message. */
  history: readonly ModelMessage[];
  /**
   * Volatile per-turn context (recalled memory, page context, @-mention
   * hydration), injected as USER messages after history and before the
   * instruction. `null`/`undefined` entries are dropped so callers can pass
   * optional slots positionally.
   */
  contextMessages?: ReadonlyArray<ModelMessage | null | undefined>;
  /** This turn's user text. */
  instruction: string;
  /** Multimodal parts attached to this turn's user message. */
  attachments?: readonly GovernedTurnAttachment[];
  /** The materialised, governed tool set (`materializeTools().tools`). */
  tools: ToolSet;
  /**
   * Model-safe aliases of the tools that mutate
   * (`materializeTools().mutatingToolNames`). They are serialized against each
   * other for the life of the turn, so two writes the model emitted in one
   * step cannot interleave.
   */
  mutatingToolNames?: readonly string[];
  /** Reasoning effort; forward only for models that support it. */
  effort?: EffortLevel | null;
  /** Hard step cap. Defaults to {@link DEFAULT_GOVERNED_TURN_MAX_STEPS}. */
  maxSteps?: number;
  /** Per-turn dollar guard; omit when the effective budget policy is off. */
  budgetGuard?: GovernedTurnBudgetGuard;
  /** Client-disconnect / cancel signal, forwarded to the provider call. */
  abortSignal?: AbortSignal;
  /** Observability hook for provider/stream errors; never swallows the part. */
  onError?: StreamAgentReplyArgs["onError"];
}

export interface GovernedTurnResult {
  /**
   * The raw AI-SDK stream. Every surface's translator consumes this directly —
   * consume it to completion BEFORE awaiting `finalText`/`usage`, which only
   * settle once the stream ends.
   */
  fullStream: AsyncIterable<unknown>;
  /** The turn's assistant prose, once the stream is drained. */
  finalText: Promise<string>;
  /** Aggregated usage across every step, once the stream is drained. */
  usage: Promise<GovernedTurnUsage>;
  /** Resolved gateway model id — the caller prices and records the turn on it. */
  modelId: string;
  /** True when a budget guard is bounding the turn alongside the step cap. */
  budgeted: boolean;
  /** The step cap actually applied. */
  maxSteps: number;
}

/** The `execute` closure of a materialised tool, narrowed to what we wrap. */
type ToolExecuteFn = (
  input: never,
  options: never,
) => PromiseLike<unknown> | unknown;

/** Shape the AI SDK hands a `stopWhen` predicate, narrowed to what we read. */
interface StepUsageSnapshot {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
}

/** Sum per-step usage into the turn total the budget guard is priced on. */
export function aggregateStepUsage(
  steps: readonly StepUsageSnapshot[],
): GovernedTurnUsage {
  const total: GovernedTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
  for (const step of steps) {
    const u = step.usage;
    if (!u) continue;
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.totalTokens += u.totalTokens ?? 0;
    total.cachedInputTokens +=
      u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
  }
  return total;
}

/**
 * Serialize the mutating tools against one another for the life of the turn.
 *
 * `materializeTools` classifies every capability that WRITES (and every
 * external MCP tool, whose semantics this process cannot know). When a model
 * emits several tool calls in one step the SDK dispatches their `execute`
 * closures concurrently; two writes racing inside one step is exactly the
 * interleaving a governed turn must not produce. Non-mutating reads keep the
 * concurrent lane — they are the common case and the reason the turn is fast.
 *
 * The lock is a promise chain scoped to this call, so it never leaks across
 * turns and a throwing tool cannot wedge it (the chain is advanced in a
 * `finally`).
 */
export function serializeMutatingTools(
  tools: ToolSet,
  mutatingToolNames: readonly string[],
): ToolSet {
  const mutating = new Set(mutatingToolNames);
  if (mutating.size === 0) return tools;

  let lock: Promise<unknown> = Promise.resolve();
  const out: Record<string, Tool> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute as ToolExecuteFn | undefined;
    if (!mutating.has(name) || typeof execute !== "function") {
      out[name] = definition;
      continue;
    }
    const serializedExecute: ToolExecuteFn = (inputValue, options) => {
      // `then` on BOTH settlements: a rejected predecessor must not skip the
      // queue for the calls behind it.
      const run = lock.then(
        () => execute(inputValue, options),
        () => execute(inputValue, options),
      );
      // Advance the chain on settle — a throwing tool must not wedge the lane.
      lock = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    // Tool is a union over its input/output generics, so a spread-with-override
    // cannot be expressed without one cast; the shape is otherwise unchanged.
    out[name] = { ...definition, execute: serializedExecute } as Tool;
  }
  return out;
}

/** Build the user message for this turn, with any multimodal parts attached. */
export function buildTurnUserMessage(
  instruction: string,
  attachments: readonly GovernedTurnAttachment[] = [],
): ModelMessage {
  if (attachments.length === 0) {
    return { role: "user", content: instruction };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: instruction },
      ...attachments.map((a) =>
        a.kind === "image"
          ? ({
              type: "image",
              image: a.data,
              mediaType: a.mediaType,
            } as const)
          : ({
              type: "file",
              data: a.data,
              mediaType: a.mediaType,
            } as const),
      ),
    ],
  };
}

/**
 * Run one governed turn.
 *
 * Returns as soon as the provider call is open: the caller drives the turn by
 * consuming {@link GovernedTurnResult.fullStream}, and only then awaits
 * `finalText`/`usage`. Awaiting either first deadlocks — those promises settle
 * from the stream the caller has not yet read.
 */
export async function runGovernedTurn(
  input: GovernedTurnInput,
): Promise<GovernedTurnResult> {
  const maxSteps = input.maxSteps ?? DEFAULT_GOVERNED_TURN_MAX_STEPS;
  const tools = serializeMutatingTools(
    input.tools,
    input.mutatingToolNames ?? [],
  );

  const messages: ModelMessage[] = [
    ...input.history,
    ...(input.contextMessages ?? []).filter(
      (m): m is ModelMessage => m !== null && m !== undefined,
    ),
    buildTurnUserMessage(input.instruction, input.attachments),
  ];

  // Both bounds are OR-ed by the SDK: the turn halts at whichever trips first.
  const stepCap = stepCountIs(maxSteps);
  const budgetGuard = input.budgetGuard;
  const stopWhen: StreamAgentReplyArgs["stopWhen"] = budgetGuard
    ? [
        stepCap,
        async ({ steps }: { steps: readonly StepUsageSnapshot[] }) =>
          (await budgetGuard(aggregateStepUsage(steps))) === "stop",
      ]
    : stepCap;

  // Resolve the model once so the id the caller records is the id the provider
  // was actually called with. `modelIdOf` because `LanguageModel` is a union
  // that also admits a bare id string — `.modelId` is not always reachable.
  const model = input.model ?? defaultModel();
  const modelId = modelIdOf(model);

  // The materialised tools re-enter tenant scope inside their own `execute`,
  // but `streamAgentReply` captures the ambient scope SYNCHRONOUSLY here to
  // re-establish it in `onFinish` for the credit charge. Entering it explicitly
  // means a caller that dispatched the turn from outside a scope still bills.
  const stream = await runInTenantScope(
    {
      orgId: input.telemetry.orgId,
      workspaceId: input.telemetry.workspaceId,
    },
    async () =>
      streamAgentReply({
        messages,
        system: input.system,
        tools,
        stopWhen,
        telemetry: input.telemetry,
        model,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.abortSignal !== undefined
          ? { abortSignal: input.abortSignal }
          : {}),
        ...(input.onError !== undefined ? { onError: input.onError } : {}),
      }),
  );

  const usage: Promise<GovernedTurnUsage> = Promise.resolve(
    stream.totalUsage,
  ).then((u) => ({
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
    // v7 exposes prompt-cache reads under inputTokenDetails; the flat
    // `cachedInputTokens` was the v6 spelling and is gone from the type.
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
  }));

  return {
    fullStream: stream.fullStream as AsyncIterable<unknown>,
    finalText: Promise.resolve(stream.text),
    usage,
    modelId,
    budgeted: budgetGuard !== undefined,
    maxSteps,
  };
}
