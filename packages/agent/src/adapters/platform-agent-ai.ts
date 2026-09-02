import { selectModel, streamAgentReply, generateObjectFor } from "@oxagen/ai";
import type {
  AgentAi,
  ModelRunArgs,
  ObjectRunArgs,
  ObjectRunResult,
} from "@oxagen/agent-engine";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { Surface } from "@oxagen/telemetry";

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
 * `stopWhen` (the engine's step cap) and `onError` are forwarded to `streamText`
 * via `streamAgentReply`, so the multi-step coding loop is bounded (no runaway
 * cost) and stream errors are captured. `abortSignal` is forwarded so a client
 * disconnect / user cancel aborts the in-flight model call. `onStepFinish`
 * (tool-call trace events) is not forwarded — it is unused by these surfaces;
 * the engine's file-edit / command / final-diff events fire from workspace tools.
 *
 * NOTE — name twin: `apps/cli/src/agent/adapters/platform-agent-ai.ts` exports a
 * DIFFERENT `createPlatformAgentAi` (an OpenAI-compatible `/v1/agent/llm` client
 * with token auth, for the standalone CLI). This one is the in-kernel adapter
 * (handlers + in-app chat route). Same name, different package, different shape —
 * import the right one for your surface.
 *
 * @param ctx       CapabilityContext for the current request.
 * @param messageId UUID of the user message that initiated the turn — used as
 *                  `execution_step_id` in ClickHouse and `reference_id` in the
 *                  credit ledger.  Pass `ctx.messageId ?? ctx.requestId`.
 * @param surface   Telemetry surface tag. Defaults to `"agent"` (the
 *                  `agent.repo.edit` sync capability); the in-app chat route
 *                  passes `"app"` so its usage attributes to the app surface.
 */
export function createPlatformAgentAi(
  ctx: CapabilityContext,
  messageId: string,
  surface: Surface = "agent",
): AgentAi {
  const telemetry = {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    surface,
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
        stopWhen: args.stopWhen,
        onError: args.onError,
        // The engine's step loop owns retries (classified, jittered backoff) —
        // SDK-internal retries underneath it multiply upstream attempts on a
        // flaky provider and block abort while they spin. Same treatment the
        // generateObject path already gets.
        maxRetries: 0,
        ...(args.abortSignal !== undefined
          ? { abortSignal: args.abortSignal }
          : {}),
        telemetry,
      });
    },

    async generateObject<T>(
      args: ObjectRunArgs<T>,
    ): Promise<ObjectRunResult<T>> {
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
