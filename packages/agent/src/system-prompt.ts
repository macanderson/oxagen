// Back-compat shim. The canonical chat system prompt now lives in the prompt
// registry (./prompts/registry) so it sits alongside every other platform
// prompt and the customer-override resolution. Existing callers that import
// `buildChatSystemPrompt` / `SystemPromptContext` keep working unchanged.
import { chatSystemPrompt, type SystemPromptContext } from "@oxagen/ai";

export type { SystemPromptContext };

// Prefer resolvePrompt({ key: "chat.system", baseline: chatSystemPrompt(ctx),
// config }) at call sites that have a workspace PromptConfig, so workspace
// "additional instructions" are honored. This shim renders the bare baseline.
export function buildChatSystemPrompt(ctx: SystemPromptContext): string {
  return chatSystemPrompt(ctx);
}
