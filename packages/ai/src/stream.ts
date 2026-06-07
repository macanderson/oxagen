import { streamText, type ModelMessage, type LanguageModel, type ToolSet, type StreamTextResult } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { defaultModel, modelIdOf } from "./models";
import type { EffortLevel } from "./catalog";

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

  return streamText({
    model,
    messages: args.messages,
    tools: args.tools,
    system: args.system,
    // When the provider locks temperature (Anthropic extended thinking,
    // OpenAI reasoning models) we must omit the field entirely — sending
    // any value, even the default, causes the upstream to reject the request.
    ...(rc.temperatureLocked ? {} : { temperature: args.temperature ?? 0.7 }),
    // Vendor-specific reasoning/thinking options, or nothing when effort is
    // undefined or the vendor has no knob (deepseek).
    ...(rc.providerOptions ? { providerOptions: rc.providerOptions } : {}),
    onFinish: async (event) => {
      const durationMs = Date.now() - startedAt;
      // AI SDK v6: usage fields are inputTokens/outputTokens (was
      // promptTokens/completionTokens in v4). `totalUsage` aggregates every
      // step of the tool-loop, so it's the correct figure to meter/bill.
      const inputTokens = event.totalUsage.inputTokens ?? 0;
      const outputTokens = event.totalUsage.outputTokens ?? 0;
      // The cost meter (provider rate card) turns tokens-in/out-by-model into
      // the USD a provider invoices us. This is the input to both the telemetry
      // cost column and the credit charge below.
      //
      // cachedTokens is omitted (defaults to 0) because this gate does not yet
      // enable prompt caching — there are no cache-control markers on the
      // messages/system, so the provider reports zero cached reads. If caching
      // is turned on, forward the provider's cache-read count here (e.g.
      // event.providerMetadata.anthropic.cacheReadInputTokens) so the meter
      // prices those tokens at the cheaper cached rate; otherwise the customer
      // is over-charged on the cached portion.
      const usage = { model: modelId, inputTokens, outputTokens };
      const costUsdMicros = providerCostUsdMicros(usage);

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
            cached_tokens: 0,
            cost_usd_micros: costUsdMicros,
            duration_ms: durationMs,
            surface: args.telemetry.surface,
            prompt_hash: promptHash,
            created_at: new Date().toISOString(),
          },
        ]);
      } catch {
        // Swallow — telemetry must never fail the chat turn.
      }

      // The gate: debit the org's credits for what this call cost us, marked
      // up to the target margin. Best-effort and post-call — a metering
      // failure must never fail the user's turn. Admission control (refusing a
      // turn when the balance is empty) is the caller's pre-turn guard via
      // billing.hasCreditBalance.
      try {
        await chargeUsageCredits({
          orgId: args.telemetry.orgId,
          referenceId: args.telemetry.messageId,
          ...usage,
        });
      } catch {
        // Swallow — credit metering must never fail the chat turn.
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
