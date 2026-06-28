import pino from "pino";
import { streamText, type ModelMessage, type LanguageModel, type ToolSet, type StreamTextResult } from "ai";
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

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "ai.stream" } });

// ── Reasoning token budget per effort level (tokens allocated to thinking) ──
const REASONING_BUDGET: Record<EffortLevel, number> = {
  low: 4096,
  medium: 8192,
  high: 12288,
};

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
      // `reasoningSummary: "auto"` causes the gateway to stream a reasoning
      // summary chunk into fullStream.
      return {
        providerOptions: {
          openai: {
            reasoningEffort: effort,
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
      // Grok exposes a reasoning effort knob but does not lock temperature.
      return {
        providerOptions: {
          xai: { reasoningEffort: effort },
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
          openai: { reasoningEffort: effort },
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
   * Required for OXA-1351 instrumentation. The caller's CapabilityContext
   * carries `orgId`, `workspaceId`, and `surface`; pass them through so
   * every LLM call lands in `token_usage` with provider, duration_ms,
   * surface, and prompt_hash. `messageId` is the user message that
   * initiated the turn — used as the execution_step_id correlation key.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    messageId: string;
  };
  onFinish?: (event: {
    text: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason: string;
  }) => Promise<void> | void;
}

export function streamAgentReply(args: StreamAgentReplyArgs): StreamTextResult<ToolSet, never> {
  const model = args.model ?? defaultModel();
  const modelId = modelIdOf(model);
  const provider = providerFromModelId(modelId);
  const startedAt = Date.now();

  // ── OTEL span: tracks the LLM stream from call to onFinish ───────────────
  // Started synchronously here (inside any parent kernel.invoke span) so it
  // inherits the parent context.  Ended asynchronously in onFinish once we
  // know token counts.  No-op when OTEL SDK is not initialised (NoopTracer).
  // Attributes are PII-safe: model/provider/surface only — never prompt text.
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
  // so a short system prompt simply isn't cached (no harm). We carry the system
  // as a leading system message (rather than the `system` param) because only
  // message-level providerOptions can place a cache_control marker.
  const cachedSystem: ModelMessage[] = args.system
    ? [
        {
          role: "system",
          content: args.system,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ]
    : [];

  return streamText({
    model,
    messages: [...cachedSystem, ...args.messages],
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
    onFinish: async (event) => {
      const durationMs = Date.now() - startedAt;
      // AI SDK v6: usage fields are inputTokens/outputTokens (was
      // promptTokens/completionTokens in v4). `totalUsage` aggregates every
      // step of the tool-loop, so it's the correct figure to meter/bill.
      const inputTokens = event.totalUsage.inputTokens ?? 0;
      const outputTokens = event.totalUsage.outputTokens ?? 0;
      // Prompt-cache reads: the AI SDK v6 gateway normalizes the provider's
      // cache-read count into `cachedInputTokens` (a subset of inputTokens).
      // Forward it so the rate card prices those tokens at the cheaper cached
      // rate — otherwise the customer is over-charged on the cached portion.
      // Zero when caching didn't engage (small prefix / non-Anthropic / cold).
      const cachedTokens = event.totalUsage.cachedInputTokens ?? 0;
      // The cost meter (provider rate card) turns tokens-in/out-by-model into
      // the USD a provider invoices us. This is the input to both the telemetry
      // cost column and the credit charge below.
      const usage = { model: modelId, inputTokens, outputTokens, cachedTokens };
      const costUsdMicros = providerCostUsdMicros(usage);

      // ── OTEL: stamp token metrics on span and close it ─────────────────────
      // Run inside the captured OTEL context so the span is correctly linked
      // to its parent (the kernel.invoke span, if present).
      context.with(_capturedOtelCtx, () => {
        _otelSpan.setAttributes({
          "ai.input_tokens": inputTokens,
          "ai.output_tokens": outputTokens,
          "ai.cached_tokens": cachedTokens,
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
