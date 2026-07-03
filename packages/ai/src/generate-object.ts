import pino from "pino";
import { generateObject, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { defaultModel, modelIdOf } from "./models";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "ai.object" } });

export interface GenerateObjectArgs<T> {
  /**
   * The Zod schema that defines the shape of the object the model must
   * produce. The inferred type `T` is the return object type.
   */
  schema: z.ZodType<T>;
  /**
   * Optional injectable language model — defaults to defaultModel() so the
   * function is unit-testable without environment variables.
   */
  model?: LanguageModel;
  /**
   * A single system instruction string (rendered as the `system` field of
   * the AI SDK call). Mutually usable with `messages`.
   */
  system?: string;
  /**
   * Full message history. When provided alongside `prompt`, messages take
   * precedence for the conversation context.
   */
  messages?: ModelMessage[];
  /**
   * Single-turn plain-text prompt. Use when there is no prior conversation.
   */
  prompt?: string;
  /** Sampling temperature (0–2). Defaults to 0 for structured output. */
  temperature?: number;
  /**
   * Optional abort signal forwarded to the AI SDK so a caller can bound the
   * wall-clock of a single generation. A hung gateway call otherwise never
   * resolves nor rejects, and a plain try/catch cannot rescue a hang — pass
   * `AbortSignal.timeout(ms)` to turn a stall into a clean abort error the
   * caller can catch. (See schema.reconcile, which must not hang the worker.)
   */
  abortSignal?: AbortSignal;
  /**
   * Optional max-retries forwarded to the AI SDK. Leave undefined to use the
   * SDK default; set to 0 when an outer system (e.g. Inngest) owns retries.
   */
  maxRetries?: number;
  /**
   * Required telemetry context forwarded from the caller's CapabilityContext.
   * Carries `orgId`, `workspaceId`, and `surface` so every generateObject call
   * lands in `token_usage` with provider, duration_ms, surface, and prompt_hash.
   * `messageId` is the user message that initiated the turn — used as the
   * execution_step_id correlation key.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    /**
     * UUID of the user message that initiated the turn, or `null` when there is
     * none. Flows into `token_usage.execution_step_id` (UUID) and
     * `credit_ledger.reference_id` (Postgres uuid) — MUST be a valid UUID or
     * null, never a free-form string like the literal "unknown".
     */
    messageId: string | null;
  };
}

export interface GenerateObjectUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerateObjectResult<T> {
  object: T;
  usage: GenerateObjectUsage;
}

/**
 * Generate a structured, typed object from a language model using the Vercel
 * AI SDK `generateObject` primitive, with full telemetry instrumentation.
 *
 * After generation the function records:
 * - A `token_usage` row to ClickHouse via @oxagen/telemetry (best-effort).
 * - A credit debit through @oxagen/billing (best-effort, post-call).
 *
 * Both writes are swallowed on failure — they must never fail the caller.
 *
 * @example
 * ```ts
 * const { object } = await generateObjectFor({
 *   schema: z.object({ summary: z.string() }),
 *   prompt: "Summarise the meeting in one sentence.",
 *   telemetry: { orgId, workspaceId, surface: "api", messageId },
 * });
 * ```
 */
export async function generateObjectFor<T>(
  args: GenerateObjectArgs<T>,
): Promise<GenerateObjectResult<T>> {
  const model = args.model ?? defaultModel();
  const modelId = modelIdOf(model);
  const provider = providerFromModelId(modelId);
  const startedAt = Date.now();

  // Derive a stable prompt text for hashing. Prefer the last user message
  // from `messages` (mirrors stream.ts), falling back to `prompt`.
  const lastUserMessage = args.messages
    ? [...args.messages].reverse().find((m) => m.role === "user")
    : undefined;
  const promptTextForHash = lastUserMessage
    ? typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content)
    : (args.prompt ?? "");

  // AI SDK v6 models the prompt as a `messages` XOR `prompt` union — passing
  // both (even as undefined) no longer type-checks. Include exactly one:
  // messages when provided, otherwise the single-turn prompt string.
  const result = await generateObject({
    model,
    schema: args.schema,
    system: args.system,
    temperature: args.temperature ?? 0,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
    ...(args.messages ? { messages: args.messages } : { prompt: args.prompt ?? "" }),
  });

  const durationMs = Date.now() - startedAt;
  // AI SDK v6: usage fields renamed to inputTokens/outputTokens.
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  // Prompt-cache reads (AI SDK v6 normalizes the provider's count). Forward so
  // the rate card prices cached tokens at the cheaper rate; 0 when caching
  // didn't engage. See stream.ts for the rationale.
  const cachedTokens = result.usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const usage = { model: modelId, inputTokens, outputTokens, cachedTokens };
  const costUsdMicros = providerCostUsdMicros(usage);

  // Telemetry write is best-effort; if ClickHouse is unreachable the caller
  // still gets the object back (same contract as stream.ts).
  try {
    const promptHash = await hashPrompt(promptTextForHash);
    await insertTokenUsage([
      {
        execution_step_id: args.telemetry.messageId,
        org_id: args.telemetry.orgId,
        workspace_id: args.telemetry.workspaceId,
        model: modelId,
        provider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface: args.telemetry.surface,
        prompt_hash: promptHash,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // Swallow — telemetry must never fail a capability call.
    logger.error({ err }, "generateObject telemetry write failed");
  }

  // Debit the org's credits for what this call cost us at the target margin.
  // Best-effort and post-call — a metering failure must not fail the caller.
  //
  // chargeUsageCredits → consumeCredits → withTenantDb → requireScope, which
  // needs an active tenant scope. Request-path callers have one; Inngest workers
  // keep tenant scope tight around their own DB ops and do NOT wrap the LLM step,
  // so this charge would otherwise run scopeless and throw TenantScopeError
  // (silently swallowed → unbilled calls, a revenue leak). Prefer the active ALS
  // scope, else rebuild it from the trusted telemetry org/workspace. Mirrors
  // stream.ts's onFinish handling.
  const capturedScope: TenantScope = getScope() ?? {
    orgId: args.telemetry.orgId,
    workspaceId: args.telemetry.workspaceId,
  };
  try {
    await runInTenantScope(capturedScope, async () => {
      await chargeUsageCredits({
        orgId: args.telemetry.orgId,
        // null → undefined → NULL reference_id; never a non-UUID string.
        referenceId: args.telemetry.messageId ?? undefined,
        ...usage,
      });
    });
  } catch (err) {
    // Swallow — credit metering must never fail a capability call.
    logger.error({ err }, "generateObject credit charge failed");
  }

  return {
    object: result.object,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: result.usage.totalTokens ?? 0,
    },
  };
}
