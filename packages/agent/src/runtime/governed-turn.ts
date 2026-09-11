/**
 * `runGovernedTurn` — the in-app governance agent's turn, run on Stella's
 * headless engine (ADR-053 §1; ADR-043 §2 for what the agent is for).
 *
 * Oxagen governs agents; it does not run them. The loop that runs this turn
 * is `stella-serve`, a container on the node, and it holds no key and runs no
 * tool. Every completion it wants comes back here as a `provider_request`,
 * answered through `streamAgentReply`, the only permitted LLM chokepoint, on
 * whichever key the organisation's funding source names (ADR-053 §2). Every
 * tool it wants comes back as a `tool_request`, answered through the
 * materialised tool's own `execute`, where IAM, entitlement, tool RBAC,
 * consent, the approval pause and the audit row already live. The engine
 * sees a tool result; it never sees a credential. That is the whole of the
 * governance argument, and it is why no tool runs anywhere else.
 *
 * What the engine owns, that the old in-process loop had to approximate: the
 * step cap, loop detection, compaction, cancellation at a step boundary, a
 * budget it can enforce, and a replayable event stream with a `seq` on every
 * frame.
 *
 * What this function keeps: its signature and its result. Both chat routes
 * consume a turn as AI-SDK-shaped stream parts and translate them into their
 * own wire formats, one of which is pinned byte for byte. The engine's events
 * are mapped onto that vocabulary in `engine/parts.ts`, and nothing
 * downstream learns which loop ran the turn.
 *
 * There is no fallback. When the engine cannot be reached the turn fails with
 * `EngineUnavailableError` before anything streams (ADR-053 §4): a quiet
 * in-process substitute would be the second copy of the loop this ADR exists
 * to prevent.
 */

import {
  defaultModel,
  modelIdOf,
  type EffortLevel,
  type ModelCredential,
  type ModelMessage,
  type OxagenTier,
  type StreamAgentReplyArgs,
  type Tool,
  type ToolSet,
  type TurnFunding,
} from "@oxagen/ai";
import {
  driveTurn,
  type CompletionUsage,
  type StellaEngineClient,
  type TurnOutcomeWire,
} from "@oxagen/stella-engine-client";
import {
  EngineUnavailableError,
  engineClientFromEnv,
  isEngineUnavailable,
} from "./engine/client";
import { fromModelMessage, toCompletionMessages } from "./engine/messages";
import { createPartMapper, type EnginePart } from "./engine/parts";
import { createProviderPort } from "./engine/provider";
import { AsyncQueue } from "./engine/queue";
import {
  executeToolRequest,
  schemaOnlyTools,
  toToolContracts,
} from "./engine/tools";
import pino from "pino";
import type { ToolGovernance } from "./materialize-tools";
import { assertToolListFitsProvider } from "./tool-budget";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.governed-turn" },
});

/**
 * Default hard ceiling on model steps in one turn. A governance answer is a
 * handful of reads plus a reply; twelve steps is generous for that and still
 * bounds the runaway case.
 */
export const DEFAULT_GOVERNED_TURN_MAX_STEPS = 12;

/**
 * How long the engine waits for this process to answer a reverse request.
 * An approval pause blocks inside a tool's `execute` for up to five minutes
 * (`APPROVAL_TTL_MS` in `materialize-tools.ts`), so the engine's deadline
 * sits a minute past that; a streamed completion resets it on every delta
 * batch, so a long answer never trips it.
 */
export const ENGINE_REVERSE_REQUEST_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * The provider id the engine echoes on every completion request. Opaque to
 * the engine and to the vendor: the host maps it, with the request's role,
 * to a model. One value, because the host is the only provider there is.
 */
export const ENGINE_PROVIDER_ID = "oxagen";

/**
 * A binary attachment carried into the turn as a multimodal message part.
 * `kind` decides the part shape: an image rides as an AI-SDK `image` part, and
 * anything else (video, and any future document type) as a `file` part.
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
 * (`@oxagen/billing`) returns. Evaluated before every model call on the usage
 * the host has metered so far; a `stop` cancels the turn on the engine.
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
   * turn. Forwarded verbatim to `streamAgentReply` on every completion, which
   * writes it to `token_usage` and charges credits against it — `messageId`
   * MUST be a UUID.
   */
  telemetry: StreamAgentReplyArgs["telemetry"];
  /** Resolved language model for the worker role. Omit for the balanced default. */
  model?: StreamAgentReplyArgs["model"];
  /**
   * The tier `model` is on. The engine's other roles pick a model relative
   * to it: a verdict never runs on the worker's tier. Defaults to balanced.
   */
  tier?: OxagenTier;
  /** The organisation's own key, when it brought one, for the other roles' models. */
  credential?: ModelCredential;
  /**
   * The fully-resolved system prompt. Byte-stable across turns of a
   * conversation so the provider's prompt cache keeps hitting — volatile
   * per-turn context belongs in `contextMessages`, never here (ADR-021 §2).
   */
  system: string;
  /** Prior turns, chronological, EXCLUDING the current user message. */
  history: readonly ModelMessage[];
  /**
   * Volatile per-turn context (recalled memory, page context, @-mention
   * hydration), injected as USER messages after history and before the
   * instruction. `null`/`undefined` entries are dropped.
   */
  contextMessages?: ReadonlyArray<ModelMessage | null | undefined>;
  /** This turn's user text. */
  instruction: string;
  /** Multimodal parts attached to this turn's user message. */
  attachments?: readonly GovernedTurnAttachment[];
  /** The materialised, governed tool set (`materializeTools().tools`). */
  tools: ToolSet;
  /**
   * Model-safe aliases of the tools that mutate. The engine serialises them
   * from the contracts' `read_only` bit; this list is also applied host-side
   * so a misdeclared contract cannot interleave two writes.
   */
  mutatingToolNames?: readonly string[];
  /**
   * Per-alias governance facts (`materializeTools().governance`), declared to
   * the engine as each tool's contract. A tool with no entry is declared high
   * risk and mutating, which is how the engine treats an undeclared one.
   */
  governance?: Record<string, ToolGovernance>;
  /** The acting user's id, attributed to every tool call the engine makes. */
  principal?: string;
  /** Reasoning effort; forward only for models that support it. */
  effort?: EffortLevel | null;
  /** Hard step cap. Defaults to {@link DEFAULT_GOVERNED_TURN_MAX_STEPS}. */
  maxSteps?: number;
  /** Per-turn dollar guard; omit when the effective budget policy is off. */
  budgetGuard?: GovernedTurnBudgetGuard;
  /**
   * Who paid the vendor for this turn's tokens (ADR-053 §2). Defaults to
   * `platform`. Pass what `resolveModelFundingSource` answered for the same
   * organisation `model` was selected for.
   */
  fundedBy?: TurnFunding;
  /** Client-disconnect / cancel signal; cancels the turn on the engine. */
  abortSignal?: AbortSignal;
  /** Observability hook for provider/stream errors; never swallows the part. */
  onError?: StreamAgentReplyArgs["onError"];
  /**
   * The engine client to use. Tests inject one bound to a fake; production
   * leaves it unset and the client is built from `STELLA_SERVE_URL` and
   * `STELLA_SERVE_TOKEN`.
   */
  engine?: StellaEngineClient;
}

export interface GovernedTurnResult {
  /**
   * The stream of AI-SDK-shaped parts. Every surface's translator consumes
   * this directly — consume it to completion BEFORE awaiting
   * `finalText`/`usage`, which only settle once the stream ends.
   */
  fullStream: AsyncIterable<unknown>;
  /** The turn's assistant prose, once the stream is drained. */
  finalText: Promise<string>;
  /** Aggregated usage across every completion, as this process metered it. */
  usage: Promise<GovernedTurnUsage>;
  /** Resolved gateway model id of the worker — the caller records the turn on it. */
  modelId: string;
  /** Who paid the vendor for the tokens — the value the ledger was told. */
  fundedBy: TurnFunding;
  /** True when a budget guard is bounding the turn alongside the step cap. */
  budgeted: boolean;
  /** The step cap actually applied. */
  maxSteps: number;
  /** The engine's turn id, for a ledger or a log line. */
  turnId: Promise<string>;
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

/** Sum per-step usage into a turn total. */
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
 * The engine partitions a step's calls on each contract's `read_only` bit and
 * dispatches only the read-only ones together, so this lock is ordinarily
 * idle. It stays because a contract is a declaration, and two writes racing
 * inside one step is exactly the interleaving a governed turn must not
 * produce whatever a declaration said. The lock is a promise chain scoped to
 * this call, so it never leaks across turns and a throwing tool cannot wedge
 * it.
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
      const run = lock.then(
        () => execute(inputValue, options),
        () => execute(inputValue, options),
      );
      lock = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
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
          ? ({ type: "image", image: a.data, mediaType: a.mediaType } as const)
          : ({ type: "file", data: a.data, mediaType: a.mediaType } as const),
      ),
    ],
  };
}

/**
 * Run one governed turn on the engine.
 *
 * Returns once the engine has been reached: the caller drives the turn by
 * consuming {@link GovernedTurnResult.fullStream}, and only then awaits
 * `finalText`/`usage`. Throws `EngineUnavailableError` when the engine is not
 * configured, not reachable, or not ready, before anything streams.
 */
export async function runGovernedTurn(
  input: GovernedTurnInput,
): Promise<GovernedTurnResult> {
  const maxSteps = input.maxSteps ?? DEFAULT_GOVERNED_TURN_MAX_STEPS;
  const tools = serializeMutatingTools(
    input.tools,
    input.mutatingToolNames ?? [],
  );
  const model = input.model ?? defaultModel();
  const modelId = modelIdOf(model);

  // What the tool list costs this turn, and whether the provider will take it
  // (#2611). Both answers are wanted before the request goes out, not after:
  // a provider that caps tools per request refuses the whole turn, and letting
  // the gateway be the one to say so produces a provider-shaped error about a
  // request nobody can inspect, on every turn, for every workspace pinned to
  // that model. This throws a sentence naming the model, the limit and the
  // count instead.
  //
  // The size is logged whether or not it is a problem, because it was not
  // visible at all before: establishing that the list ran to 45,007 tokens —
  // 92.4% of the cacheable prefix — took a manual measurement, and a number
  // nobody can see is a number nobody manages. The list grows one tool at a
  // time, and each one looks free.
  const toolBudget = assertToolListFitsProvider(modelId, tools);
  logger.info(
    {
      modelId,
      toolCount: toolBudget.toolCount,
      estimatedToolTokens: toolBudget.estimatedTokens,
      largestTool: toolBudget.largestTool,
    },
    "governed turn tool budget",
  );
  const fundedBy: TurnFunding = input.fundedBy ?? "platform";
  const tier: OxagenTier = input.tier ?? "balanced";

  const client = input.engine ?? engineClientFromEnv();
  await assertEngineReady(client);

  const contracts = await toToolContracts(tools, input.governance ?? {});
  const messages = toCompletionMessages({
    system: input.system,
    history: input.history,
    context: (input.contextMessages ?? []).filter(
      (m): m is ModelMessage => m !== null && m !== undefined,
    ),
    user: buildTurnUserMessage(input.instruction, input.attachments),
  });

  const parts = new AsyncQueue<EnginePart>();
  const mapper = createPartMapper();
  const hostUsage: GovernedTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
  const onUsage = (usage: CompletionUsage): void => {
    hostUsage.inputTokens += usage.input_tokens;
    hostUsage.outputTokens += usage.output_tokens;
    hostUsage.totalTokens += usage.input_tokens + usage.output_tokens;
    hostUsage.cachedInputTokens += usage.cached_input_tokens ?? 0;
  };

  const provider = createProviderPort({
    model,
    workerTier: tier,
    ...(input.credential ? { credential: input.credential } : {}),
    system: input.system,
    tools: schemaOnlyTools(tools),
    telemetry: input.telemetry,
    fundedBy,
    effort: input.effort,
    onUsage,
  });

  // The budget guard runs before each completion on what this process has
  // metered so far. A `stop` cancels the turn on the engine, which reports
  // the abort as its outcome; the reverse request in flight is rejected as
  // cancelled so the engine does not wait on it.
  const budgetGuard = input.budgetGuard;
  const turnAbort = new AbortController();
  if (input.abortSignal?.aborted) turnAbort.abort();
  input.abortSignal?.addEventListener("abort", () => turnAbort.abort(), {
    once: true,
  });

  let resolveText!: (text: string) => void;
  let rejectText!: (err: unknown) => void;
  const finalText = new Promise<string>((resolve, reject) => {
    resolveText = resolve;
    rejectText = reject;
  });
  let resolveUsage!: (usage: GovernedTurnUsage) => void;
  let rejectUsage!: (err: unknown) => void;
  const usage = new Promise<GovernedTurnUsage>((resolve, reject) => {
    resolveUsage = resolve;
    rejectUsage = reject;
  });
  let resolveTurnId!: (id: string) => void;
  let rejectTurnId!: (err: unknown) => void;
  const turnId = new Promise<string>((resolve, reject) => {
    resolveTurnId = resolve;
    rejectTurnId = reject;
  });
  // A route that never reads these must not surface an unhandled rejection.
  for (const p of [finalText, usage, turnId]) p.catch(() => undefined);

  const emit = (list: EnginePart[]): void => {
    for (const part of list) parts.push(part);
  };
  const settle = (outcome: TurnOutcomeWire): void => {
    emit(mapper.finish(outcome, hostUsage));
    parts.end();
    resolveText(mapper.text);
    resolveUsage({ ...hostUsage });
  };

  void driveTurn(client, {
    request: {
      provider_id: ENGINE_PROVIDER_ID,
      messages,
      tools: contracts,
      ...(input.principal ? { principal: input.principal } : {}),
      max_steps: maxSteps,
      reverse_request_timeout_ms: ENGINE_REVERSE_REQUEST_TIMEOUT_MS,
      budget: { mode: budgetGuard ? "observed" : "off" },
      ...(input.effort ? { engine: { effort: input.effort } } : {}),
    },
    signal: turnAbort.signal,
    handlers: {
      onProviderRequest: async (request, context) => {
        if (budgetGuard && (await budgetGuard(hostUsage)) === "stop") {
          turnAbort.abort();
          throw Object.assign(new Error("turn budget exhausted"), {
            name: "AbortError",
          });
        }
        return provider(request, context);
      },
      onToolRequest: async (request, context) => {
        const execution = await executeToolRequest(
          tools,
          request.name,
          request.input,
          { toolCallId: request.request_id, signal: context.signal },
        );
        mapper.recordToolReturn(
          request.name,
          request.input,
          execution.raw,
          execution.failed,
          execution.error,
        );
        return execution.output;
      },
      onEvent: (event) => emit(mapper.map(event)),
    },
  })
    .then((result) => {
      resolveTurnId(result.turnId);
      settle(result.outcome);
    })
    .catch((err: unknown) => {
      const error = isEngineUnavailable(err)
        ? new EngineUnavailableError(errorMessage(err), err)
        : err;
      input.onError?.({ error });
      // The failure reaches the surface as a part, the way the old loop's
      // stream errors did, and the promises reject for a caller awaiting them.
      parts.push({ type: "error", error });
      parts.end();
      rejectTurnId(error);
      rejectText(error);
      rejectUsage(error);
    });

  return {
    fullStream: parts as AsyncIterable<unknown>,
    finalText,
    usage,
    modelId,
    fundedBy,
    budgeted: budgetGuard !== undefined,
    maxSteps,
    turnId,
  };
}

/**
 * One readiness probe before the turn. It is cheap, it is unauthenticated,
 * and it turns "connection refused" into the one error every surface knows
 * how to show. A 503 is the engine starting or draining, which is the same
 * answer for the person waiting.
 */
async function assertEngineReady(client: StellaEngineClient): Promise<void> {
  let ready: { ready: boolean; state: string };
  try {
    ready = await client.ready();
  } catch (err) {
    throw new EngineUnavailableError(errorMessage(err), err);
  }
  if (!ready.ready) {
    throw new EngineUnavailableError(`engine is ${ready.state}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export {
  EngineUnavailableError,
  ENGINE_UNAVAILABLE_MESSAGE,
} from "./engine/client";
export type { EnginePart } from "./engine/parts";
// Re-exported so a surface can build the engine's transcript the way the
// turn does, for a ledger or a replay.
export { fromModelMessage };
