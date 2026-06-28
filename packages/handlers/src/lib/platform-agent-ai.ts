import { selectModel, streamAgentReply, generateObjectFor } from "@oxagen/ai";
import type { AgentAi, ModelRunArgs, ObjectRunArgs, ObjectRunResult } from "@oxagen/agent-engine";
import type { CapabilityContext } from "@oxagen/oxagen";

/**
 * Platform AgentAi adapter — routes all coding-engine LLM calls through
 * `@oxagen/ai` so every turn is metered, credit-charged, and
 * telemetry-instrumented via the Vercel AI Gateway (ADR-019).
 *
 * The adapter translates between the engine's `ModelRunArgs` / `ObjectRunArgs`
 * shapes and the `@oxagen/ai` function signatures (`streamAgentReply`,
 * `generateObjectFor`), preserving the exact arg names defined in
 * `packages/ai/src/stream.ts`.
 *
 * Note: `streamAgentReply` does not forward `stopWhen`, `onError`, or
 * `onStepFinish` to `streamText`. These are accepted in `ModelRunArgs` for
 * interface compatibility but are silently dropped by this adapter; the
 * engine's own try/catch on `textStream` handles errors, and the model stops
 * naturally when it emits no further tool calls. A future update to
 * `streamAgentReply` can lift this limitation.
 *
 * @param ctx       CapabilityContext for the current request.
 * @param messageId UUID of the user message that initiated the turn — used as
 *                  `execution_step_id` in ClickHouse and `reference_id` in the
 *                  credit ledger.  Pass `ctx.messageId ?? ctx.requestId`.
 */
export function createPlatformAgentAi(
  ctx: CapabilityContext,
  messageId: string,
): AgentAi {
  const telemetry = {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    surface: "agent" as const,
    messageId,
  };

  return {
    stream(args: ModelRunArgs) {
      return streamAgentReply({
        messages: args.messages,
        model: selectModel({ model: args.model }),
        tools: args.tools,
        system: args.system,
        effort: args.effort,
        telemetry,
      });
    },

    async generateObject<T>(args: ObjectRunArgs<T>): Promise<ObjectRunResult<T>> {
      const result = await generateObjectFor<T>({
        schema: args.schema,
        model: selectModel({ model: args.model }),
        system: args.system,
        messages: args.messages,
        prompt: args.prompt,
        abortSignal: args.abortSignal,
        telemetry,
      });
      return {
        object: result.object,
        usage: {
          inputTokens: result.usage.promptTokens,
          outputTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        },
      };
    },
  };
}
