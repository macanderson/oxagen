/**
 * `runGovernedTurn`: a turn of stella, the in-app agent, run on Stella's
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
  modelIdentityFor,
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
  type CompletionResult,
  type CompletionUsage,
  type StellaEngineClient,
  type ToolOutput,
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

/**
 * The model call this process made for the engine failed, and the turn ended
 * on it. The engine only learns a classified error (`classifyProviderError`)
 * and reports the failure back as an `error` event carrying text, so without
 * this the turn's error part was a bare `Error` with no code. Every surface
 * then showed its generic failure, and a revoked vendor key, an unknown model
 * and a provider outage all read the same.
 *
 * `status` is the provider's HTTP status when it answered one. The message
 * names the status and never the vendor's body, which can echo the request.
 */
export class ModelCallFailedError extends Error {
  override readonly name = "ModelCallFailedError";
  readonly code = "model_call_failed" as const;
  constructor(
    readonly status: number | null,
    cause: unknown,
  ) {
    super(
      status === null
        ? "the model call failed before the provider answered"
        : `the model provider answered ${String(status)}`,
      { cause },
    );
  }
}

/**
 * The error a failed model call ends the turn with. One that already carries
 * a stable `code` (the minted key's spend ceiling, `assistant_model_key_limit`)
 * is kept as it is, because a surface branches on that code; anything else is
 * named by the provider's status.
 */
export function modelCallFailure(err: unknown): Error {
  if (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    return err;
  }
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return new ModelCallFailedError(
    typeof status === "number" ? status : null,
    err,
  );
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
  /**
   * The materialised, governed tool set (`materializeTools().tools`), or a
   * belt's `tools` (`createToolBelt`): every tool the engine may be asked
   * for, meta-tools included.
   */
  tools: ToolSet;
  /**
   * What the provider is shown on each completion (`createToolBelt().
   * modelTools`). Omitted, the model sees every tool in `tools`. The list
   * is checked against the provider's per-request cap before the turn
   * starts, on the shape the first completion will send.
   */
  modelTools?: () => ToolSet;
  /**
   * Model-safe aliases of the tools that mutate. The engine serialises them
   * from the contracts' `read_only` bit; this list is also applied host-side
   * so a misdeclared contract cannot interleave two writes.
   */
  mutatingToolNames?: readonly string[];
  /**
   * Model-facing alias → canonical capability name, as `materializeTools`
   * built it. The engine asks for tools by the sanitized alias; the ledger
   * must attribute the call to the capability the run spec authorized, so
   * every receipt resolves through this map. A name absent from it is already
   * canonical (the belt's own meta-tools).
   */
  toolNameMap?: Readonly<Record<string, string>>;
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
  /**
   * The run this turn is recorded as. The in-app agent always passes one
   * (`openAssistantRun`); a caller that passes none records nothing, which
   * is the shape a unit test of the loop alone takes.
   */
  ledger?: TurnLedger;
}

/** A completion the host answered, as the ledger records it. */
export interface TurnLedgerModelCall {
  /** The `provider_request` frame's seq. */
  seq: number;
  requestId: string;
  role: string;
  provider: string;
  model: string;
  outcome: "completed" | "failed" | "cancelled";
  usage?: CompletionUsage;
  /**
   * What the provider answered, for the frame's body (MC spec §8.2). Absent
   * on the paths where nothing was answered — a budget refusal, a transport
   * failure, a cancellation — where the receipt is the whole record.
   */
  response?: unknown;
}

/**
 * The host is about to ask the provider for a completion. Written BEFORE the
 * request leaves the process, so a completion whose tokens are incurred can
 * never be absent from the record (see `model.engine_call_started`).
 */
export interface TurnLedgerModelIntent {
  /** The `provider_request` frame's seq. */
  seq: number;
  requestId: string;
  role: string;
  provider: string;
  /** The CONFIGURED model id; the provider has not resolved one yet. */
  model: string;
  /**
   * The completion request about to leave the process — its messages, its
   * tools and its parameters — for the frame's body (MC spec §8.2). The
   * turn's prompt is inside it, so this is the frame a `view` reader opens
   * to see what the agent was asked.
   */
  request?: unknown;
}

/**
 * The host is about to invoke a tool. Written BEFORE the call so a mutation
 * that commits can never be absent from the record (see
 * `tool.engine_call_started`).
 */
export interface TurnLedgerToolIntent {
  /** The `tool_request` frame's seq. */
  seq: number;
  requestId: string;
  /** The canonical capability name — the identity the run spec authorized. */
  toolName: string;
  /** The model-facing alias, when it differs from the canonical name. */
  toolAlias?: string;
  input: unknown;
}

/** A tool call the host answered, as the ledger records it. */
export interface TurnLedgerToolCall {
  /** The `tool_request` frame's seq. */
  seq: number;
  requestId: string;
  /**
   * The canonical capability name. For an external MCP tool the engine asks
   * by a sanitized, sometimes collision-suffixed alias; recording that alias
   * here made the evidence impossible to join back to the capability that was
   * actually authorized, so the identity is always the canonical name and the
   * alias travels beside it.
   */
  toolName: string;
  /** The model-facing alias, when it differs from the canonical name. */
  toolAlias?: string;
  outcome: "completed" | "failed" | "denied" | "cancelled";
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

/** How the turn ended, as the ledger seals it. */
export type TurnLedgerOutcome =
  | { status: "completed"; text: string }
  | { status: "aborted"; reason: string }
  | { status: "failed"; error: string };

/**
 * The run the turn is recorded as (MC spec §14.1). Every reverse request is
 * recorded BEFORE its answer is posted to the engine: a receipt that cannot
 * be written rejects the request, and the turn is cancelled rather than
 * answered from a path the ledger did not see. `seal` runs once, after the
 * engine's outcome or the failure that ended the turn.
 */
export interface TurnLedger {
  /** Write-ahead: recorded before the provider is contacted, never a call. */
  modelCallStarted(record: TurnLedgerModelIntent): Promise<void>;
  modelCall(record: TurnLedgerModelCall): Promise<void>;
  /** Write-ahead: recorded before the tool runs, and never counted as a call. */
  toolCallStarted(record: TurnLedgerToolIntent): Promise<void>;
  toolCall(record: TurnLedgerToolCall): Promise<void>;
  seal(outcome: TurnLedgerOutcome): Promise<void>;
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
  // Who is about to serve the turn. On the organisation's own vendor key the
  // id is the vendor's bare spelling (`gpt-5.2`), so the provider ceilings
  // below are found from the credential rather than from a prefix that is not
  // there to read.
  const identity = modelIdentityFor(modelId, input.credential);

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
  const shown = input.modelTools;
  const modelTools = shown
    ? () => schemaOnlyTools(shown())
    : () => schemaOnlyTools(tools);
  const toolBudget = assertToolListFitsProvider(
    { modelId: identity.wireId, provider: identity.provider },
    modelTools(),
  );
  logger.info(
    {
      modelId,
      provider: identity.provider,
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
    tools: modelTools,
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
  // An error part after a failed model call is that failure, told by its code.
  const withModelFailure = (list: EnginePart[]): EnginePart[] => {
    const failure = modelFailure;
    if (failure === null) return list;
    return list.map((part) =>
      part.type === "error" ? { type: "error", error: failure } : part,
    );
  };
  const ledger = input.ledger;
  // The seal is the last write of the turn. It runs after the engine's
  // outcome (or the failure that ended the turn) and before the result
  // promises settle, so a caller that awaits `finalText` holds a sealed run.
  const sealLedger = async (outcome: TurnLedgerOutcome): Promise<void> => {
    if (!ledger) return;
    try {
      await ledger.seal(outcome);
    } catch (err) {
      logger.error(
        { err, outcome: outcome.status },
        "assistant run seal failed",
      );
      throw err;
    }
  };
  // The first receipt that could not be written. The turn it cancelled ends
  // with the engine's aborted outcome, and the result promises reject with
  // this error: a turn that could not be recorded does not answer.
  let receiptError: { error: unknown } | null = null;
  // The first model call that failed for a reason other than this turn's own
  // cancel. The engine ends the turn on it and reports only its text, so the
  // turn's error part is replaced with this one: it keeps a code a surface can
  // name (`modelCallFailure`).
  let modelFailure: Error | null = null;
  const settle = async (outcome: TurnOutcomeWire): Promise<void> => {
    await sealLedger(
      outcome.status === "completed"
        ? { status: "completed", text: outcome.text }
        : { status: "aborted", reason: outcome.reason },
    );
    emit(withModelFailure(mapper.finish(outcome, hostUsage)));
    parts.end();
    if (receiptError) {
      rejectText(receiptError.error);
      rejectUsage(receiptError.error);
      return;
    }
    resolveText(mapper.text);
    resolveUsage({ ...hostUsage });
  };
  // A receipt that cannot be written ends the turn: the engine is cancelled
  // and the request that owned the receipt is rejected, so no answer built
  // on an unrecorded step reaches the model or the person. The receipt is
  // built inside the try, so a recorder that throws while building it (a
  // digest over a value that is not plain JSON) cancels the turn the same way.
  const recorded = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (err) {
      receiptError ??= { error: err };
      turnAbort.abort();
      throw err;
    }
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
        const receipt = {
          seq: request.seq,
          requestId: request.request_id,
          role: request.role,
          provider: request.provider_id,
        };
        if (budgetGuard && (await budgetGuard(hostUsage)) === "stop") {
          // The request that hit the budget is the evidence for why the run
          // stopped. Aborting before writing it sealed the run `cancelled`
          // with no record of the request that caused it, so "the budget
          // stopped this turn" was unprovable — and that is precisely what a
          // customer disputing a bill asks us to show. The event schema
          // already carries `cancelled`; the model is the configured one
          // because the request never reached the provider, the same as the
          // failure path below.
          if (ledger) {
            await recorded(() =>
              ledger.modelCall({
                ...receipt,
                model: modelId,
                outcome: "cancelled",
              }),
            );
          }
          turnAbort.abort();
          throw Object.assign(new Error("turn budget exhausted"), {
            name: "AbortError",
          });
        }
        // Write-ahead, the mirror of `toolCallStarted` below. The intention is
        // durable BEFORE the provider is contacted, so tokens that are
        // incurred and metered can never be missing from the record: if this
        // append fails, `recorded` aborts the turn and the request is never
        // made at all. Recording only afterwards meant a provider that
        // answered and a terminal append that then failed sealed the run
        // failed with no model call in its evidence, while the vendor had
        // been paid for the completion — a record that is confidently wrong
        // about a charge, which is the one an invoice dispute turns on.
        //
        // `modelId` and not `result.model`: the resolved id is not knowable
        // until the provider answers. The completed event carries that one,
        // and the pair read together is what shows a gateway substitution.
        if (ledger) {
          await recorded(() =>
            ledger.modelCallStarted({ ...receipt, model: modelId, request }),
          );
        }
        let result: CompletionResult;
        try {
          result = await provider(request, context);
        } catch (err) {
          // The turn's own abort, read directly: `driveTurn` aborts the
          // request's `context.signal` only after its cancel grace period, so
          // a caller that disconnects mid-call would otherwise read as a
          // provider failure here.
          const cancelled = turnAbort.signal.aborted || context.signal.aborted;
          if (!cancelled) modelFailure ??= modelCallFailure(err);
          if (ledger) {
            await recorded(() =>
              ledger.modelCall({
                ...receipt,
                model: modelId,
                outcome: cancelled ? "cancelled" : "failed",
              }),
            );
          }
          throw err;
        }
        if (ledger) {
          await recorded(() =>
            ledger.modelCall({
              ...receipt,
              model: result.model,
              outcome: "completed",
              usage: result.usage,
              response: result,
            }),
          );
        }
        return result;
      },
      onToolRequest: async (request, context) => {
        const startedAt = Date.now();
        // The engine asks by the model-facing alias; the ledger attributes the
        // call to the capability the run spec authorized. An alias absent from
        // the map is already canonical (the belt's meta-tools).
        const canonical = input.toolNameMap?.[request.name] ?? request.name;
        const alias = canonical === request.name ? undefined : request.name;
        // Write-ahead. The intention is durable BEFORE the tool runs, so a
        // side effect that commits can never be missing from the record: if
        // this append fails, `recorded` aborts the turn and the tool is never
        // invoked at all. Recording only afterwards meant a transient ledger
        // failure could commit a mutation and then seal the run failed with
        // no receipt, leaving evidence that asserted it never happened.
        if (ledger) {
          await recorded(() =>
            ledger.toolCallStarted({
              seq: request.seq,
              requestId: request.request_id,
              toolName: canonical,
              ...(alias ? { toolAlias: alias } : {}),
              input: request.input,
            }),
          );
        }
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
        if (ledger) {
          await recorded(() =>
            ledger.toolCall({
              seq: request.seq,
              requestId: request.request_id,
              toolName: canonical,
              ...(alias ? { toolAlias: alias } : {}),
              outcome: toolOutcome(execution),
              input: request.input,
              // The receipt digests what the engine is answered with (the
              // rendered wire output), which is plain JSON for every tool.
              ...(execution.failed
                ? { error: errorMessage(execution.error ?? "tool failed") }
                : { output: execution.output }),
              durationMs: Date.now() - startedAt,
            }),
          );
        }
        return execution.output;
      },
      onEvent: (event) => emit(withModelFailure(mapper.map(event))),
    },
  })
    .then(async (result) => {
      resolveTurnId(result.turnId);
      await settle(result.outcome);
    })
    .catch(async (err: unknown) => {
      const error = isEngineUnavailable(err)
        ? new EngineUnavailableError(errorMessage(err), err)
        : err;
      input.onError?.({ error });
      await sealLedger({
        status: "failed",
        error: errorMessage(error),
      }).catch(() => undefined);
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

/** How a tool execution reads on the ledger: a refusal is `denied`, a cancel is `cancelled`. */
function toolOutcome(execution: {
  failed: boolean;
  output: ToolOutput;
}): TurnLedgerToolCall["outcome"] {
  if (!execution.failed) return "completed";
  const errorClass =
    "error" in execution.output ? execution.output.error.class : undefined;
  if (errorClass === "refused_by_policy" || errorClass === "permission_denied")
    return "denied";
  return "failed";
}

export {
  EngineUnavailableError,
  ENGINE_UNAVAILABLE_MESSAGE,
} from "./engine/client";
export type { EnginePart } from "./engine/parts";
// Re-exported so a surface can build the engine's transcript the way the
// turn does, for a ledger or a replay.
export { fromModelMessage };
