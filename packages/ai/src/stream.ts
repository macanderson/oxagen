import { streamText, type CoreMessage, type LanguageModel, type ToolSet } from "ai";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { defaultModel } from "./models";
import type { EffortLevel } from "./catalog";

export interface StreamAgentReplyArgs {
  messages: CoreMessage[];
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

export function streamAgentReply(args: StreamAgentReplyArgs) {
  const model = args.model ?? defaultModel();
  const provider = providerFromModelId(model.modelId);
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

  return streamText({
    model,
    messages: args.messages,
    tools: args.tools,
    system: args.system,
    temperature: args.temperature ?? 0.7,
    // Reasoning effort is expressed via the OpenAI-style `reasoningEffort`
    // provider option. The gateway client is built with @ai-sdk/openai, which
    // reads provider options under the `openai` namespace; the Vercel AI
    // Gateway forwards `reasoning_effort` to whichever vendor backs the model.
    // Only set when the caller passed `effort` (already gated to
    // reasoning-capable models by the route via supportsReasoning).
    ...(args.effort
      ? { providerOptions: { openai: { reasoningEffort: args.effort } } }
      : {}),
    onFinish: async (event) => {
      const durationMs = Date.now() - startedAt;
      const inputTokens = event.usage.promptTokens ?? 0;
      const outputTokens = event.usage.completionTokens ?? 0;
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
      const usage = { model: model.modelId, inputTokens, outputTokens };
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
            model: model.modelId,
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
          promptTokens: event.usage.promptTokens ?? 0,
          completionTokens: event.usage.completionTokens ?? 0,
          totalTokens: event.usage.totalTokens ?? 0,
        },
        finishReason: event.finishReason,
      });
    },
  });
}
