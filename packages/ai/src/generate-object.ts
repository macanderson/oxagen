import { generateObject, type LanguageModel, type CoreMessage } from "ai";
import { z } from "zod";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { defaultModel } from "./models.js";

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
  messages?: CoreMessage[];
  /**
   * Single-turn plain-text prompt. Use when there is no prior conversation.
   */
  prompt?: string;
  /** Sampling temperature (0–2). Defaults to 0 for structured output. */
  temperature?: number;
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
    messageId: string;
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
  const provider = providerFromModelId(model.modelId);
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

  const result = await generateObject({
    model,
    schema: args.schema,
    system: args.system,
    messages: args.messages,
    prompt: args.prompt,
    temperature: args.temperature ?? 0,
  });

  const durationMs = Date.now() - startedAt;
  const inputTokens = result.usage.promptTokens ?? 0;
  const outputTokens = result.usage.completionTokens ?? 0;
  const usage = { model: model.modelId, inputTokens, outputTokens };
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
        model: model.modelId,
        provider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: 0,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface: args.telemetry.surface,
        prompt_hash: promptHash,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Swallow — telemetry must never fail a capability call.
  }

  // Debit the org's credits for what this call cost us at the target margin.
  // Best-effort and post-call — a metering failure must not fail the caller.
  try {
    await chargeUsageCredits({
      orgId: args.telemetry.orgId,
      referenceId: args.telemetry.messageId,
      ...usage,
    });
  } catch {
    // Swallow — credit metering must never fail a capability call.
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
