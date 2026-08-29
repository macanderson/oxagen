/**
 * Gateway-direct `AgentAi` adapter — routes engine LLM calls straight to the
 * Vercel AI Gateway using `AI_GATEWAY_API_KEY`, with NO platform round-trip.
 *
 * Where {@link createPlatformAgentAi} posts through the platform's metered
 * `/v1/agent/llm` endpoint (requires a logged-in session), this adapter passes
 * plain gateway slugs (`vendor/model`) directly to the AI SDK, which resolves
 * them against the gateway. It exists for exactly two callers:
 *
 *   1. Headless benchmark containers (`OXAGEN_ALLOW_NO_SESSION=1` — see
 *      `lib/session.ts`): there is no account to meter against, and the bench
 *      harness supplies `AI_GATEWAY_API_KEY` itself.
 *   2. The `--local` / not-logged-in BYOK path — `AI_GATEWAY_API_KEY` (any
 *      vendor), or `ANTHROPIC_API_KEY` alone (Anthropic models direct; see
 *      `agent/anthropic-direct.ts`).
 *
 * Reasoning effort is applied client-side here (the platform normally does this
 * server-side). The per-vendor mapping below is a faithful copy of
 * `reasoningRequestConfig` in `packages/ai/src/stream.ts` — the canonical
 * source of truth. It is replicated (not imported) because `@oxagen/ai` pulls
 * in billing/database/tenancy, none of which belong in the CLI. If the mapping
 * changes there, update this copy.
 */
import type {
  AgentAi,
  ModelRunArgs,
  ObjectRunArgs,
  ObjectRunResult,
} from "@oxagen/agent-engine";
import { streamText, generateObject } from "ai";
import type { ModelMessage } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { debugLog } from "../../lib/debug-log.js";
import { resolveAiCredential, MissingAiKeyError } from "../env.js";

/** Reasoning token budget per effort level (tokens allocated to thinking). */
const REASONING_BUDGET: Record<string, number> = {
  low: 4096,
  medium: 8192,
  high: 12288,
  xhigh: 24576,
  max: 49152,
};

/** Clamp the deeper Anthropic-only tiers for vendors that top out at "high". */
function clampEffortToHigh(effort: string): "low" | "medium" | "high" {
  return effort === "xhigh" || effort === "max"
    ? "high"
    : (effort as "low" | "medium" | "high");
}

/**
 * Vendor-specific `providerOptions` for reasoning/thinking, derived from the
 * gateway slug prefix. Mirrors `reasoningRequestConfig` in
 * `packages/ai/src/stream.ts`. Neither AgentAi adapter passes `temperature`,
 * so the canonical helper's `temperatureLocked` flag is not needed here.
 * Exported for tests.
 */
export function gatewayReasoningOptions(
  modelId: string,
  effort: string | undefined,
): Record<string, JSONObject> | undefined {
  if (!effort) return undefined;
  const vendor = modelId.includes("/") ? modelId.split("/")[0] : "unknown";
  const budget = REASONING_BUDGET[effort] ?? REASONING_BUDGET["medium"];

  switch (vendor) {
    case "anthropic":
      // Claude 4.x adaptive thinking: `thinking.type: "adaptive"` + depth via
      // `output_config.effort` (older `enabled`+`budgetTokens` is rejected).
      return {
        anthropic: {
          thinking: { type: "adaptive" },
          outputConfig: { effort },
        },
      };
    case "openai":
      return {
        openai: {
          reasoningEffort: clampEffortToHigh(effort),
          // "detailed" streams the reasoning summary into fullStream as
          // reasoning-delta parts; "auto" frequently yields none via the gateway.
          reasoningSummary: "detailed",
        },
      };
    case "google":
      return {
        google: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
        },
      };
    case "xai":
      return { xai: { reasoningEffort: clampEffortToHigh(effort) } };
    case "deepseek":
      // R1-style models stream reasoning natively with no effort knob.
      return undefined;
    default:
      return { openai: { reasoningEffort: clampEffortToHigh(effort) } };
  }
}

export interface GatewayAgentAiOptions {
  /**
   * Working directory used to resolve `AI_GATEWAY_API_KEY` /
   * `ANTHROPIC_API_KEY` from .env.local.
   */
  cwd?: string;
}

// 1-hour cache TTL, not the 5-minute default. Measured agent-loop cache hit
// was ~48%: a long bash step (build, install, model download) between two LLM
// calls routinely exceeds the 5-min default TTL, so the next call re-creates
// the whole prefix from scratch (fresh price) instead of reading it cached.
// A 1h TTL survives those gaps — cache *writes* cost 2x fresh input, but on a
// 17+ step loop the read savings (10x) dominate. `ttl` rides the same
// anthropic providerOptions namespace, ignored by non-Anthropic vendors.
const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
} as const;

/**
 * Anthropic prompt caching for the agent loop. Mirrors the canonical
 * system-message breakpoint in `packages/ai/src/stream.ts` (the `anthropic`
 * providerOptions namespace is ignored by every other vendor, so this is a
 * no-op for OpenAI/Google/xAI models), and additionally marks the last two
 * transcript messages so each successive step of a long tool loop re-reads the
 * ever-growing conversation prefix from cache (~1/10th input price, faster
 * prefill) instead of re-billing the whole transcript on every step. Two tail
 * breakpoints (not one) let the provider's longest-prefix lookup hit the
 * previous step's cache entry even after a new message lands.
 * Exported for tests.
 */
export function withPromptCaching(
  system: string | undefined,
  messages: ModelMessage[],
): ModelMessage[] {
  const out = messages.map((m, i) =>
    i >= messages.length - 2
      ? ({
          ...m,
          providerOptions: { ...m.providerOptions, ...ANTHROPIC_CACHE },
        } as ModelMessage)
      : m,
  );
  return system
    ? [
        {
          role: "system",
          content: system,
          providerOptions: { ...ANTHROPIC_CACHE },
        },
        ...out,
      ]
    : out;
}

/**
 * Build a gateway-direct {@link AgentAi}. Throws {@link MissingAiKeyError}
 * immediately when no AI credential can be resolved — callers get one
 * clear, actionable failure instead of a per-call auth error mid-turn.
 *
 * With a gateway key, plain slugs resolve through the Vercel AI Gateway (any
 * vendor). With only an `ANTHROPIC_API_KEY`, `resolveAiCredential` installs the
 * direct-Anthropic global provider, so the same string slugs resolve straight
 * against the Anthropic API (Anthropic models only).
 */
export function createGatewayAgentAi(
  opts: GatewayAgentAiOptions = {},
): AgentAi {
  if (!resolveAiCredential(opts.cwd ?? process.cwd())) {
    throw new MissingAiKeyError();
  }

  return {
    stream(args: ModelRunArgs) {
      void debugLog("llm", "llm.stream.request", {
        transport: "gateway-direct",
        model: args.model,
        messageCount: Array.isArray(args.messages) ? args.messages.length : 0,
        toolNames: args.tools ? Object.keys(args.tools) : [],
      });
      const providerOptions = gatewayReasoningOptions(args.model, args.effort);
      return streamText({
        // A plain string model id resolves through the Vercel AI Gateway using
        // AI_GATEWAY_API_KEY.
        model: args.model,
        // System is folded into the message list as a cached system message —
        // only message-level providerOptions can carry a cache_control marker.
        // The system content is our own prompt, not user input, so the SDK's
        // system-in-messages injection warning does not apply here.
        messages: withPromptCaching(args.system, args.messages),
        allowSystemInMessages: true,
        tools: args.tools,
        stopWhen: args.stopWhen,
        abortSignal: args.abortSignal,
        // The engine's step loop owns retries (classified retryable-vs-fatal,
        // jittered backoff, maxRetries 4) — leaving the SDK default (2) under
        // it multiplies upstream attempts on a flaky gateway and blocks abort
        // while the inner retries spin. Same treatment as generateObject.
        maxRetries: 0,
        ...(providerOptions ? { providerOptions } : {}),
        onError: args.onError,
        // ALWAYS defined (even when the caller passes no onStepFinish) so we can
        // capture per-LLM-call usage as a side-effect. Without this, per-turn
        // token cost and the cache-read hit rate on long tool loops would be
        // invisible. Cache reads live under `inputTokenDetails.cacheReadTokens`
        // in AI SDK v7 (see generateObject below). The engine port still
        // receives only toolCalls/toolResults.
        onStepFinish: (step) => {
          const u = step.usage;
          void debugLog("llm", "llm.stream.step", {
            model: args.model,
            inputTokens: u?.inputTokens ?? 0,
            outputTokens: u?.outputTokens ?? 0,
            cachedInputTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
            finishReason: step.finishReason,
          });
          args.onStepFinish?.({
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
          });
        },
        // Final per-turn rollup: total usage across every step of this stream,
        // with the cache-read split — the decisive per-turn cost + cache-hit
        // signal for tuning and for spotting an ineffective cache prefix.
        onFinish: (final) => {
          const u = final.totalUsage;
          const cached = u?.inputTokenDetails?.cacheReadTokens ?? 0;
          const fresh = u?.inputTokens ?? 0;
          void debugLog("llm", "llm.stream.finish", {
            model: args.model,
            steps: final.steps?.length ?? 0,
            inputTokens: fresh,
            outputTokens: u?.outputTokens ?? 0,
            cachedInputTokens: cached,
            cacheHitPct:
              fresh + cached > 0
                ? Math.round((100 * cached) / (fresh + cached))
                : 0,
          });
        },
      });
    },

    async generateObject<T>(
      args: ObjectRunArgs<T>,
    ): Promise<ObjectRunResult<T>> {
      void debugLog("llm", "llm.object.request", {
        transport: "gateway-direct",
        model: args.model,
      });
      // Fold system into a cached system message via the same
      // `withPromptCaching` breakpoint the `stream` path uses. The judge,
      // planner, evaluator, and selector all call `generateObject` with a
      // large, stable system prompt on every invocation — without a cache
      // breakpoint here it was rebilled at full input price every call
      // instead of the provider's much cheaper cached-read rate. `prompt`
      // (when given, XOR with `messages`) becomes the sole message so the
      // same message-level cache_control shaping applies uniformly.
      const baseMessages: ModelMessage[] = args.messages ?? [
        { role: "user", content: args.prompt ?? "" },
      ];
      const result = await generateObject({
        model: args.model,
        schema: args.schema,
        messages: withPromptCaching(args.system, baseMessages),
        allowSystemInMessages: true,
        abortSignal: args.abortSignal,
      });
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
      return { object: result.object, usage };
    },
  };
}
