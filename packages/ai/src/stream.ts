import { streamText, type CoreMessage, type LanguageModel, type ToolSet } from "ai";
import { defaultModel } from "./models.js";

export interface StreamAgentReplyArgs {
  messages: CoreMessage[];
  model?: LanguageModel;
  tools?: ToolSet;
  system?: string;
  temperature?: number;
  onFinish?: (event: {
    text: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason: string;
  }) => Promise<void> | void;
}

// Returns the raw streamText result so callers can pipe it into either
// a Response (HTTP) or an RSC stream. Keeping the wrapper thin avoids a
// second layer of buffering between the SDK and the transport.
export function streamAgentReply(args: StreamAgentReplyArgs) {
  return streamText({
    model: args.model ?? defaultModel(),
    messages: args.messages,
    tools: args.tools,
    system: args.system,
    temperature: args.temperature ?? 0.7,
    onFinish: args.onFinish
      ? async (event) => {
          await args.onFinish?.({
            text: event.text,
            usage: {
              promptTokens: event.usage.promptTokens ?? 0,
              completionTokens: event.usage.completionTokens ?? 0,
              totalTokens: event.usage.totalTokens ?? 0,
            },
            finishReason: event.finishReason,
          });
        }
      : undefined,
  });
}
