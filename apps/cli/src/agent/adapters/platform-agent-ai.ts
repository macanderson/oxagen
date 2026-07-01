/**
 * Platform `AgentAi` adapter for the CLI — routes every coding-engine LLM call
 * through the platform's OpenAI-compatible endpoint (`/v1/agent/llm`) so
 * turns are metered, credit-charged, and telemetry-instrumented server-side,
 * with the session token as the API key (ADR-019: no CLI-side BYOK).
 *
 * The endpoint routes by model slug (which encodes the tier), so reasoning
 * `effort` is applied server-side and is not forwarded as a request field.
 */
import type {
  AgentAi,
  ModelRunArgs,
  ObjectRunArgs,
  ObjectRunResult,
} from "@oxagen/agent-engine";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, generateObject } from "ai";
import { debugLog } from "../../lib/debug-log.js";

export interface PlatformAgentAiOptions {
  apiUrl: string;
  token: string;
  orgSlug: string;
  workspaceSlug: string;
}

export function createPlatformAgentAi(opts: PlatformAgentAiOptions): AgentAi {
  const provider = createOpenAICompatible({
    name: "oxagen-platform",
    // Route: POST /v1/agent/llm/chat/completions — no /api prefix, no org/workspace
    // slugs in the path; org+workspace scope is pre-bound to the API key.
    baseURL: `${opts.apiUrl}/v1/agent/llm`,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "x-org-slug": opts.orgSlug,
      "x-workspace-slug": opts.workspaceSlug,
    },
  });

  return {
    stream(args: ModelRunArgs) {
      // Per-turn LLM telemetry: record the request shape routed through the
      // platform (which meters + instruments it server-side) when debugging.
      void debugLog("llm", "llm.stream.request", {
        model: args.model,
        messageCount: Array.isArray(args.messages) ? args.messages.length : 0,
        toolNames: args.tools ? Object.keys(args.tools) : [],
      });
      return streamText({
        model: provider(args.model),
        system: args.system,
        messages: args.messages,
        tools: args.tools,
        stopWhen: args.stopWhen,
        abortSignal: args.abortSignal,
        // Forward the requested reasoning effort as an extra body field. The
        // openai-compatible provider merges `providerOptions[<name>]` into the
        // request body verbatim, so `reasoning_effort` (OpenAI's canonical field)
        // reaches the platform's /v1/agent/llm endpoint, which applies it to the
        // upstream model. Omitted entirely when no effort is set, so the server's
        // per-slug default still governs.
        ...(args.effort
          ? {
              providerOptions: {
                "oxagen-platform": { reasoning_effort: args.effort },
              },
            }
          : {}),
        onError: args.onError,
        // Forward step completion (carries the tool call/result trace events the
        // engine turns into ToolEvents), narrowing the SDK's StepResult to the
        // engine port's shape.
        onStepFinish: args.onStepFinish
          ? (step) =>
              args.onStepFinish?.({
                toolCalls: step.toolCalls,
                toolResults: step.toolResults,
              })
          : undefined,
      });
    },

    async generateObject<T>(args: ObjectRunArgs<T>): Promise<ObjectRunResult<T>> {
      const common = {
        model: provider(args.model),
        schema: args.schema,
        system: args.system,
        abortSignal: args.abortSignal,
      };
      void debugLog("llm", "llm.object.request", { model: args.model });
      // generateObject takes a `prompt` XOR `messages` — pass exactly one.
      const result = args.messages
        ? await generateObject({ ...common, messages: args.messages })
        : await generateObject({ ...common, prompt: args.prompt ?? "" });
      const usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      };
      void debugLog("llm", "llm.object.response", { model: args.model, usage });
      return {
        object: result.object,
        usage,
      };
    },
  };
}
