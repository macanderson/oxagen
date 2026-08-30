/**
 * Platform `AgentAi` adapter for the CLI — routes every coding-engine LLM call
 * through the platform's OpenAI-compatible endpoint (`/v1/agent/llm`) so
 * turns are metered, credit-charged, and telemetry-instrumented server-side,
 * with the session token as the API key — no provider key ever leaves the
 * machine on this path. The BYOK / not-logged-in alternative is a separate
 * adapter ({@link createGatewayAgentAi} in `gateway-agent-ai.ts`); a caller
 * picks one or the other, and this one never reads a local provider key.
 *
 * The endpoint routes by model slug (which encodes the tier), so the server
 * always has a per-slug reasoning default. A caller-supplied `effort` is
 * forwarded on top of it as the OpenAI-canonical `reasoning_effort` body field
 * (see `stream` below); omitting `effort` leaves the server default in charge.
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

    async generateObject<T>(
      args: ObjectRunArgs<T>,
    ): Promise<ObjectRunResult<T>> {
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
        // AI SDK v7 nests cache reads under `inputTokenDetails`; flatten to
        // match StreamRunResult's usage (see engine.ts) so evaluator/judge
        // calls price their cache reads the same way worker steps do.
        cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
      };
      void debugLog("llm", "llm.object.response", { model: args.model, usage });
      return {
        object: result.object,
        usage,
      };
    },
  };
}
