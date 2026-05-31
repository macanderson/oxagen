import { streamText, type CoreMessage, type LanguageModel, type ToolSet } from "ai";
import { providerFromModelId, type Surface } from "@oxagen/telemetry";
import { defaultModel } from "./models.js";
import { recordAIUsage } from "./meter.js";

export interface StreamAgentReplyArgs {
  messages: CoreMessage[];
  model?: LanguageModel;
  tools?: ToolSet;
  system?: string;
  temperature?: number;
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
    onFinish: async (event) => {
      const durationMs = Date.now() - startedAt;
      const inputTokens = event.usage.promptTokens ?? 0;
      const outputTokens = event.usage.completionTokens ?? 0;
      // cachedTokens defaults to 0 — prompt caching is not yet enabled on
      // this surface (no cache-control markers). When turned on, forward the
      // provider's cache-read count so the meter prices cached tokens at the
      // cheaper rate (e.g. event.providerMetadata.anthropic.cacheReadInputTokens).
      //
      // Telemetry + credit metering via shared helper (best-effort; never
      // fails the chat turn). Admission control is the caller's pre-turn
      // guard via billing.hasCreditBalance.
      await recordAIUsage({
        executionStepId: args.telemetry.messageId,
        orgId: args.telemetry.orgId,
        workspaceId: args.telemetry.workspaceId,
        model: model.modelId,
        provider,
        inputTokens,
        outputTokens,
        durationMs,
        surface: args.telemetry.surface,
        promptTextForHash,
      });
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
