// Thin re-export. The canonical chat system prompt lives in @oxagen/ai's prompt
// registry, alongside every other platform prompt and the customer-override
// resolution; this module only keeps the `buildChatSystemPrompt` /
// `SystemPromptContext` names importable from @oxagen/agent.
import { chatSystemPrompt, type SystemPromptContext } from "@oxagen/ai";

export type { SystemPromptContext };

// Prefer resolvePrompt({ key: "chat.system", baseline: chatSystemPrompt(ctx),
// config }) at call sites that have a workspace PromptConfig, so workspace
// "additional instructions" are honored. This shim renders the bare baseline.
export function buildChatSystemPrompt(ctx: SystemPromptContext): string {
  return chatSystemPrompt(ctx);
}
