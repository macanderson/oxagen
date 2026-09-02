import pino from "pino";
import {
  streamText,
  type ModelMessage,
  type LanguageModel,
  type ToolSet,
  type StreamTextResult,
} from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { trace, context, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { defaultModel, modelIdOf } from "./models";
import type { EffortLevel } from "./catalog";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.stream" },
});

// ── Reasoning token budget per effort level (tokens allocated to thinking) ──
const REASONING_BUDGET: Record<EffortLevel, number> = {
  low: 4096,
  medium: 8192,
  high: 12288,
  xhigh: 24576,
  max: 49152,
};

/**
 * Vendors whose effort knob only understands `low | medium | high` (OpenAI's
 * `reasoning_effort`, xAI's Grok). The deeper Anthropic tiers `xhigh`/`max` are
 * clamped to `high` for them so a request never sends an unsupported value.
 */
function clampEffortToHigh(effort: EffortLevel): "low" | "medium" | "high" {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/**
 * Per-vendor configuration required to surface reasoning/thinking tokens
 * in `fullStream`. Different providers use incompatible option shapes; this
 * helper centralises the mapping so the `streamText` call stays clean.
 */
export interface ReasoningRequestConfig {
  /** Provider options to spread into the `streamText` call. Undefined when no
   *  effort was requested or the vendor has no effort knob (e.g. deepseek). */
  providerOptions?: Record<string, JSONObject>;
  /**
   * When `true` the caller MUST omit `temperature` entirely — the upstream
   * provider will reject any non-default temperature while thinking is active
   * (Anthropic, OpenAI reasoning models). When `false` the caller may pass
   * its normal temperature.
   */
  temperatureLocked: boolean;
}

/**
 * Build the vendor-specific `providerOptions` (and `temperatureLocked` flag)
 * needed to emit reasoning/thinking tokens from `fullStream`.
 *
 * Vendor is derived from the gateway model id prefix (`vendor/model-slug`).
 * An id without a prefix (e.g. a plain slug) falls through to the `openai`
 * back-compat namespace.
 *
 * @param modelId - Vercel AI Gateway model id, e.g. "anthropic/claude-opus-4.8"
 * @param effort  - Reasoning effort level; `undefined` → no-op (no providerOptions)
 */
export function reasoningRequestConfig(
  modelId: string,
  effort: EffortLevel | undefined,
): ReasoningRequestConfig {
  if (effort === undefined) {
    return { temperatureLocked: false };
  }

  const vendor = modelId.includes("/") ? modelId.split("/")[0] : "unknown";
  const budget = REASONING_BUDGET[effort];

  switch (vendor) {
    case "anthropic":
      // Claude 4.x ("adaptive thinking") models reject the older
      // `thinking.type: "enabled"` + `budgetTokens` shape — they require
      // `thinking.type: "adaptive"` and control depth via `output_config.effort`
      // (the gateway maps the camelCase `outputConfig` provider option through).
      // Thinking still requires temperature to be omitted (provider errors otherwise).
      return {
        providerOptions: {
          anthropic: {
            thinking: { type: "adaptive" },
            outputConfig: { effort },
          },
        },
        temperatureLocked: true,
      };

    case "openai":
      // Reasoning models (gpt-5.x / o-series) reject non-default temperature.
      return {
        providerOptions: {
          openai: {
            // OpenAI's reasoning_effort tops out at "high" — clamp the deeper
            // Anthropic-only tiers down so the request is never rejected.
            reasoningEffort: clampEffortToHigh(effort),
            // "detailed" streams the model's reasoning summary into fullStream
            // (as reasoning-delta parts); "auto" frequently yields no summary at
            // all through the gateway, leaving the reasoning card unfed.
            reasoningSummary: "detailed",
          },
        },
        temperatureLocked: true,
      };

    case "google":
      // Gemini thinking config; temperature is NOT locked for Google.
      return {
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: budget,
            },
          },
        },
        temperatureLocked: false,
      };

    case "xai":
      // Grok exposes a reasoning effort knob (low|medium|high) but does not lock
      // temperature; clamp the deeper Anthropic-only tiers to "high".
      return {
        providerOptions: {
          xai: { reasoningEffort: clampEffortToHigh(effort) },
        },
        temperatureLocked: false,
      };

    case "deepseek":
      // DeepSeek-R1-style models stream reasoning natively with no effort knob.
      return { temperatureLocked: false };

    default:
      // Unknown/unrecognised vendor: back-compat with the previous openai-
      // namespace behaviour so existing callers don't regress silently.
      return {
        providerOptions: {
          openai: { reasoningEffort: clampEffortToHigh(effort) },
        },
        temperatureLocked: false,
      };
  }
}

export interface StreamAgentReplyArgs {
  messages: ModelMessage[];
  model?: LanguageModel;
  tools?: ToolSet;
  system?: string;
  temperature?: number;
  /**
   * Reasoning effort for reasoning-capable models. Maps to the OpenAI-style
   * `reasoning_effort` request field, which the Vercel AI Gateway normalizes
   * per-provider. Only forward this for models that actually support reasoning
   * (see `supportsReasoning` in ./catalog) — passing it to a non-reasoning
   * model can be rejected upstream. Omit to use the provider default.
   */
  effort?: EffortLevel;
  /**
   * Forwarded verbatim to `streamText`. The chat surface omits these (SDK
   * defaults apply, unchanged); the agent-engine surface passes a `stopWhen`
   * step cap so the multi-step coding loop is bounded — without it an agentic
   * tool loop can run unbounded (runaway cost) — plus an `onError` capture.
   */
  stopWhen?: Parameters<typeof streamText>[0]["stopWhen"];
  onError?: Parameters<typeof streamText>[0]["onError"];
  /**
   * Hard cap on output tokens for this turn, forwarded verbatim to `streamText`.
   * The OpenAI-compatible CLI proxy maps the request's `max_tokens` here so a
   * single coding turn stays bounded. Omit to use the provider default.
   */
  maxOutputTokens?: number;
  /**
   * Tool-selection strategy forwarded verbatim to `streamText`
   * (`"auto" | "none" | "required" | { type: "tool"; toolName }`). The
   * OpenAI-compatible proxy maps the request's `tool_choice` here. Omit to use
   * the SDK default ("auto" when tools are present).
   */
  toolChoice?: Parameters<typeof streamText>[0]["toolChoice"];
  /**
   * Forwarded verbatim to `streamText`. The agent-engine step loop passes the
   * turn's `AbortSignal` so a client disconnect (a closed SSE connection) or a
   * user cancel aborts the in-flight model call instead of streaming to nobody.
   * Omit when the caller has no cancellation source.
   */
  abortSignal?: AbortSignal;
  /**
   * SDK-internal retry count, forwarded verbatim to `streamText`. Pass 0 when
   * an OUTER system owns retries — the agent-engine step loop already runs a
   * classified retry policy (retryable-only, fatal fast-fail, jittered
   * backoff), so leaving the SDK default (2) underneath it multiplies upstream
   * attempts on a flaky provider and blocks abort during the inner retries.
   * Same treatment the generateObject path already gets. Omit on surfaces with
   * no outer retry loop (chat, A2A, the LLM proxy) to keep the SDK default.
   */
  maxRetries?: number;
  /**
   * The caller's CapabilityContext carries `orgId`, `workspaceId`, and
   * `surface`; pass them through so every LLM call lands in `token_usage`
   * with provider, duration_ms, surface, and prompt_hash. `messageId` is the
   * user message that initiated the turn — used as the execution_step_id
   * correlation key.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    /**
     * UUID of the user message that initiated the turn. Flows verbatim into
     * `token_usage.execution_step_id` (a UUID column) and
     * `credit_ledger.reference_id` (a Postgres `uuid` column), so it MUST be a
     * valid UUID. A free-form string like "unknown" breaks BOTH writes — the
     * ClickHouse row is dropped and the credit charge throws and is swallowed,
     * leaving the turn unbilled. Unlike the generateObject/embed paths this
     * field is not nullable, so there is no "no step" escape hatch: mint a UUID.
     */
    messageId: string;
  };
  onFinish?: (event: {
    text: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    finishReason: string;
  }) => Promise<void> | void;
}

// RUNTIME_CONTEXT (v7 middle generic) is the SDK's `Context` alias for
// `Record<string, unknown>` — spelled inline because `ai` does not re-export it.
export function streamAgentReply(
  args: StreamAgentReplyArgs,
): StreamTextResult<ToolSet, Record<string, unknown>, never> {
  const model = args.model ?? defaultModel();
  const modelId = modelIdOf(model);
  const provider = providerFromModelId(modelId);
  const startedAt = Date.now();

  // ── OTEL span: tracks the LLM stream from call to onFinish ───────────────
  // Started synchronously here (inside any parent kernel.invoke span) so it
  // inherits the parent context.  Ended asynchronously in onFinish once we
  // know token counts.  No-op when OTEL SDK is not initialised (NoopTracer).
  // Attributes are PII-safe: model/provider/surface only — never prompt text.
  //
  // KNOWN GAP — onFinish is the ONLY terminal path wired here. The SDK fires it
  // on a clean finish, and routes an abort to `onAbort` and a failure to
  // `onError`, neither of which this function supplies (`args.onError` is the
  // caller's own handler and is forwarded verbatim, not chained). So a turn the
  // client cancels mid-stream — the agent-engine step loop passes a real
  // AbortSignal — leaves this span open forever and charges the org nothing for
  // the tokens the provider already produced. Wiring `onEnd` (fires on every
  // terminal outcome) is the fix; it is a behavior change and deliberately not
  // made here.
  const _otelSpan = trace.getTracer("oxagen.ai.stream").startSpan("ai.stream", {
    kind: SpanKind.CLIENT,
    attributes: {
      "ai.model": modelId,
      "ai.provider": provider,
      "ai.surface": args.telemetry.surface as string,
    },
  });
  // Capture the OTEL context (including parent span) so onFinish can restore
  // it for proper parent↔child span linkage in the trace backend.
  const _capturedOtelCtx = trace.setSpan(context.active(), _otelSpan);

  // Capture the tenant scope NOW, before the stream starts. The AI SDK's
  // onFinish callback fires asynchronously after the stream completes — by then
  // the AsyncLocalStorage context has ended, so withTenantDb / requireScope
  // throw TenantScopeError. We re-establish the scope inside onFinish via
  // runInTenantScope. Prefer the active ALS scope, but FALL BACK to the
  // telemetry org/workspace (always provided) when streamAgentReply was invoked
  // outside an ALS scope (e.g. the chat route handler isn't itself wrapped in
  // runInTenantScope) — otherwise the credit charge runs scopeless and the
  // org is never billed for the turn (a silent revenue leak).
  const capturedScope: TenantScope = getScope() ?? {
    orgId: args.telemetry.orgId,
    workspaceId: args.telemetry.workspaceId,
  };
  // Render the user-message content into a stable hash key. The prompt
  // text itself stays in Postgres `chat.messages.content` — we ship only
  // the cohort key to ClickHouse per memory.
  const lastUserMessage = [...args.messages]
    .reverse()
    .find((m) => m.role === "user");
  const promptTextForHash =
    typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage?.content ?? "");

  const rc = reasoningRequestConfig(modelId, args.effort);

  // Prompt caching: mark the (stable, per-workspace) system prompt as an
  // Anthropic ephemeral cache breakpoint so repeated turns in a conversation
  // re-read it from cache at ~1/10th the input price instead of re-billing the
  // full prefix every turn. The `anthropic` providerOptions namespace is
  // ignored by every other vendor (OpenAI/Google/xAI/…), so this is a no-op —
  // never an error — for non-Anthropic models. Caching is keyed on the exact
  // prefix bytes and only engages above the provider's minimum cacheable size,
  // so a short system prompt isn't cached (no harm). We carry the system
  // as a leading system message (rather than the `system` param) because only
  // message-level providerOptions can place a cache_control marker.
  const cachedSystem: ModelMessage[] = args.system
    ? [
        {
          role: "system",
          content: args.system,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ]
    : [];

  return streamText({
    model,
    messages: [...cachedSystem, ...args.messages],
    // AI SDK v7 rejects system-role entries inside `messages` by default. We
    // deliberately carry the system prompt as a leading system message (only
    // message-level providerOptions can hold the cache_control marker above),
    // and proxy callers (agent.llm) forward client system messages verbatim.
    allowSystemInMessages: true,
    tools: args.tools,
    // When the provider locks temperature (Anthropic extended thinking,
    // OpenAI reasoning models) we must omit the field entirely — sending
    // any value, even the default, causes the upstream to reject the request.
    ...(rc.temperatureLocked ? {} : { temperature: args.temperature ?? 0.7 }),
    // Vendor-specific reasoning/thinking options, or nothing when effort is
    // undefined or the vendor has no knob (deepseek).
    ...(rc.providerOptions ? { providerOptions: rc.providerOptions } : {}),
    ...(args.stopWhen !== undefined ? { stopWhen: args.stopWhen } : {}),
    ...(args.onError !== undefined ? { onError: args.onError } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
    ...(args.maxOutputTokens !== undefined
      ? { maxOutputTokens: args.maxOutputTokens }
      : {}),
    ...(args.toolChoice !== undefined ? { toolChoice: args.toolChoice } : {}),
    ...(args.abortSignal !== undefined
      ? { abortSignal: args.abortSignal }
      : {}),
    onFinish: async (event) => {
      const durationMs = Date.now() - startedAt;
      // AI SDK v6: usage fields are inputTokens/outputTokens (was
      // promptTokens/completionTokens in v4). `totalUsage` aggregates every
      // step of the tool-loop, so it's the correct figure to meter/bill.
      const inputTokens = event.totalUsage.inputTokens ?? 0;
      const outputTokens = event.totalUsage.outputTokens ?? 0;
      // Prompt-cache reads: the AI SDK v6 gateway normalizes the provider's
      // cache-read count into `inputTokenDetails.cacheReadTokens` (a subset of
      // inputTokens). Forward it so the rate card prices those tokens at the
      // cheaper cached rate — otherwise the customer is over-charged on the
      // cached portion. Zero when caching didn't engage (small prefix /
      // non-Anthropic / cold).
      const cachedTokens =
        event.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
      // Prompt-cache WRITES (cache creation): the AI SDK v7 gateway exposes these
      // as `inputTokenDetails.cacheWriteTokens` (NOT `cacheCreationTokens` — that
      // is the raw Anthropic field name, renamed by the SDK). Also a subset of
      // `inputTokens`. Providers bill writes at a premium (Anthropic 1.25x base
      // input); forwarding the count lets the rate card price them correctly
      // instead of billing them as fresh 1x input. Zero on non-Anthropic
      // or when no prefix was cached this turn.
      const cacheWriteTokens =
        event.totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0;
      // The cost meter (provider rate card) turns tokens-in/out-by-model into
      // the USD a provider invoices us. This is the input to both the telemetry
      // cost column and the credit charge below.
      const usage = {
        model: modelId,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
      };
      const costUsdMicros = providerCostUsdMicros(usage);

      // ── OTEL: stamp token metrics on span and close it ─────────────────────
      // Run inside the captured OTEL context so the span is correctly linked
      // to its parent (the kernel.invoke span, if present).
      context.with(_capturedOtelCtx, () => {
        _otelSpan.setAttributes({
          "ai.input_tokens": inputTokens,
          "ai.output_tokens": outputTokens,
          "ai.cached_tokens": cachedTokens,
          "ai.cache_write_tokens": cacheWriteTokens,
          "ai.cost_usd_micros": costUsdMicros,
          "ai.duration_ms": durationMs,
        });
        _otelSpan.setStatus({ code: SpanStatusCode.OK });
        _otelSpan.end();
      });

      // Telemetry write is best-effort; if ClickHouse is unreachable, the
      // chat still completes and the message persists in Postgres.
      try {
        const promptHash = await hashPrompt(promptTextForHash);
        await insertTokenUsage([
          {
            execution_step_id: args.telemetry.messageId,
            org_id: args.telemetry.orgId,
            workspace_id: args.telemetry.workspaceId,
            model: modelId,
            provider,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_tokens: cachedTokens,
            cache_write_tokens: cacheWriteTokens,
            cost_usd_micros: costUsdMicros,
            duration_ms: durationMs,
            surface: args.telemetry.surface,
            prompt_hash: promptHash,
            created_at: new Date().toISOString(),
          },
        ]);
      } catch (err) {
        // Swallow — telemetry must never fail the chat turn.
        logger.error({ err }, "stream telemetry write failed");
      }

      // The gate: debit the org's credits for what this call cost us, marked
      // up to the target margin. Best-effort and post-call — a metering
      // failure must never fail the user's turn. Admission control (refusing a
      // turn when the balance is empty) is the caller's pre-turn guard via
      // billing.hasCreditBalance.
      //
      // chargeUsageCredits calls withTenantDb internally, which calls
      // requireScope(). The AI SDK fires onFinish after the stream ends, outside
      // the original request ALS context. We re-establish the scope using the
      // context captured synchronously before the stream was started.
      try {
        // capturedScope is always set (active ALS scope, or rebuilt from the
        // telemetry org/workspace above), so chargeUsageCredits → withTenantDb →
        // requireScope always runs inside a valid tenant scope.
        await runInTenantScope(capturedScope, async () => {
          await chargeUsageCredits({
            orgId: args.telemetry.orgId,
            referenceId: args.telemetry.messageId,
            ...usage,
          });
        });
      } catch (err) {
        // Swallow — credit metering must never fail the chat turn.
        logger.error({ err }, "stream credit charge failed");
      }
      await args.onFinish?.({
        text: event.text,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: event.totalUsage.totalTokens ?? 0,
        },
        finishReason: event.finishReason,
      });
    },
  });
}
