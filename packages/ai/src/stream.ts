import { streamText, type CoreMessage, type LanguageModel, type ToolSet } from "ai";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { defaultModel } from "./models.js";

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

// Cost estimation is intentionally provider-agnostic here: each provider
// surfaces input/output token costs through its model metadata, but the AI
// SDK doesn't expose them uniformly. Until we wire a per-model price table
// (separate ticket), token_usage.cost_usd_micros stays 0 and we compute
// cost downstream in the billing rollup function.
const COST_USD_MICROS_PLACEHOLDER = 0;

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
            input_tokens: event.usage.promptTokens ?? 0,
            output_tokens: event.usage.completionTokens ?? 0,
            cached_tokens: 0,
            cost_usd_micros: COST_USD_MICROS_PLACEHOLDER,
            duration_ms: durationMs,
            surface: args.telemetry.surface,
            prompt_hash: promptHash,
            created_at: new Date().toISOString(),
          },
        ]);
      } catch {
        // Swallow — telemetry must never fail the chat turn.
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
