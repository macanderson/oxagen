import pino from "pino";
import type { TurnFunding } from "./funding-source";
import { withOutputBudgetRetry } from "./output-budget";
import { generateObject, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import {
  chargeUsageCredits,
  providerCostUsdMicros,
  type CreditReason,
} from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";
import { defaultModel, modelIdOf } from "./models";
import {
  readCache,
  writeCache,
  sha256Hex,
  type CacheOptions,
  type CachedUsage,
} from "./cache";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.object" },
});

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
   * Cap on generated tokens, forwarded to the AI SDK as `maxOutputTokens`.
   *
   * Unset by default, which is what every existing call site keeps: the SDK
   * then sends no `max_tokens` and the provider applies the model's own
   * ceiling. That costs nothing on a flat-rate gateway and a great deal
   * elsewhere — the gateway reserves credit against the **full** ceiling rather
   * than against what the answer will use, so a 64k-ceiling model is refused
   * outright on a small balance before generating anything.
   *
   * That refusal is now handled rather than described: it names the ceiling the
   * balance can afford, and `withOutputBudgetRetry` asks again at exactly that
   * number, once (#2629). A ceiling set here is therefore an upper bound the
   * gateway may lower, not a value the call fails on.
   *
   * Set it where the shape of the answer is known and bounded. Whoever sets it
   * owns the truncation: too low and the object arrives incomplete and fails
   * schema validation — louder than a silently short answer, but a failure.
   */
  maxOutputTokens?: number;
  /**
   * Who paid the vendor for this call (ADR-053 §3). `platform` (the default)
   * charges the organisation's credits; `org` reports the usage and charges
   * nothing, because the organisation's own key paid. Must match the
   * funding source the `model` was selected with.
   */
  fundedBy?: TurnFunding;
  /** Ledger reason for a platform-funded charge; callers keep the default. */
  chargeReason?: CreditReason;
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
  /**
   * OPT-IN response cache. Omit for chat/agent-loop calls — NEVER cache those.
   * Attach it only on deterministic background inference (title generation,
   * classification, enrichment) where an identical prompt yields the same
   * answer. On a hit the model call is skipped entirely: no token spend, no
   * credit charge — only a cheap cache-hit event lands in ClickHouse so the
   * savings are measurable. See ./cache for the two-layer (exact + semantic)
   * lookup semantics; entries are strictly org/workspace-scoped.
   */
  cache?: CacheOptions;
}

/**
 * Stable signature of the output schema, folded into the cache key so two call
 * sites that share a prompt+model+surface but expect different shapes never
 * collide. Uses the ZodObject's top-level keys when available (the common case
 * for structured output), else the schema's type name.
 */
function schemaSignature(schema: z.ZodType<unknown>): string {
  const def = (schema as unknown as { _def?: { typeName?: string } })._def;
  const shape = (schema as unknown as { shape?: Record<string, unknown> })
    .shape;
  if (shape && typeof shape === "object") {
    return "object:" + Object.keys(shape).sort().join(",");
  }
  return def?.typeName ?? "unknown";
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

  // ── Response cache (opt-in) ──────────────────────────────────────────────
  // When a call site opts in, hash the prompt once (reused for telemetry below)
  // and try the cache before spending on the model. A hit returns the stored
  // object with zero token spend and no credit charge. A semantic miss returns
  // the query embedding so we can reuse it on the write rather than embed twice.
  let cachePromptHash: string | undefined;
  let cacheQueryEmbedding: number[] | undefined;
  const cacheOptions: CacheOptions | undefined = args.cache;
  if (cacheOptions) {
    cachePromptHash = await hashPrompt(promptTextForHash);
    const shapeHash = sha256Hex(
      [
        args.system ?? "",
        String(args.temperature ?? 0),
        schemaSignature(args.schema),
      ].join("\0"),
    );
    const read = await readCache<T>(
      {
        orgId: args.telemetry.orgId,
        workspaceId: args.telemetry.workspaceId,
        surface: args.telemetry.surface,
        promptHash: cachePromptHash,
        model: modelId,
        shapeHash,
        promptText: promptTextForHash,
      },
      cacheOptions,
    );
    if (read.hit) {
      // Serve from cache — no model call, no telemetry write, no credit charge.
      return {
        object: read.hit.value,
        usage: {
          promptTokens: read.hit.usage.inputTokens,
          completionTokens: read.hit.usage.outputTokens,
          totalTokens: read.hit.usage.inputTokens + read.hit.usage.outputTokens,
        },
      };
    }
    cacheQueryEmbedding = read.queryEmbedding;
  }

  // AI SDK v6 models the prompt as a `messages` XOR `prompt` union — passing
  // both (even as undefined) no longer type-checks. Include exactly one:
  // messages when provided, otherwise the single-turn prompt string.
  // The gateway prices the request against the CEILING, not against what the
  // answer will use, so a low balance is refused before a word is written. The
  // refusal names the ceiling it can afford, so it is answerable: ask once more
  // at that number (#2629). Anything that is not a credit refusal propagates
  // untouched, and a second refusal is not retried again.
  const result = await withOutputBudgetRetry(
    (maxOutputTokens) =>
      generateObject({
        model,
        schema: args.schema,
        system: args.system,
        temperature: args.temperature ?? 0,
        ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
        ...(args.maxRetries !== undefined
          ? { maxRetries: args.maxRetries }
          : {}),
        // Spread rather than passed as undefined: a call site that does not set
        // a cap must send no max_tokens at all, exactly as before.
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(args.messages
          ? { messages: args.messages }
          : { prompt: args.prompt ?? "" }),
      }),
    args.maxOutputTokens,
  );

  const durationMs = Date.now() - startedAt;
  // AI SDK v6: usage fields renamed to inputTokens/outputTokens.
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  // Prompt-cache reads (AI SDK v6 normalizes the provider's count). Forward so
  // the rate card prices cached tokens at the cheaper rate; 0 when caching
  // didn't engage. See stream.ts for the rationale.
  const cachedTokens = result.usage.inputTokenDetails?.cacheReadTokens ?? 0;
  // Prompt-cache WRITES (AI SDK v7: inputTokenDetails.cacheWriteTokens — not
  // cacheCreationTokens). Billed at a provider premium; forward so the rate card
  // prices them correctly rather than as fresh input. See stream.ts.
  const cacheWriteTokens =
    result.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const usage = {
    model: modelId,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
  };
  const costUsdMicros = providerCostUsdMicros(usage);

  // Populate the cache on a miss so the next identical call is free. Best-effort
  // inside writeCache; reuses the query embedding computed during the read.
  if (cacheOptions && cachePromptHash) {
    const cachedUsage: CachedUsage = { ...usage, costUsdMicros };
    const shapeHash = sha256Hex(
      [
        args.system ?? "",
        String(args.temperature ?? 0),
        schemaSignature(args.schema),
      ].join(" "),
    );
    await writeCache(
      {
        orgId: args.telemetry.orgId,
        workspaceId: args.telemetry.workspaceId,
        surface: args.telemetry.surface,
        promptHash: cachePromptHash,
        model: modelId,
        shapeHash,
        promptText: promptTextForHash,
      },
      cacheOptions,
      result.object,
      cachedUsage,
      "object",
      cacheQueryEmbedding,
    );
  }

  // Telemetry write is best-effort; if ClickHouse is unreachable the caller
  // still gets the object back (same contract as stream.ts).
  try {
    const promptHash = cachePromptHash ?? (await hashPrompt(promptTextForHash));
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
        cache_write_tokens: cacheWriteTokens,
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
  //
  // ADR-053 §3: only when the platform key paid. A call the organisation's own
  // key answered is reported above and charged nothing here.
  if ((args.fundedBy ?? "platform") === "platform") {
    try {
      await runInTenantScope(capturedScope, async () => {
        await chargeUsageCredits({
          orgId: args.telemetry.orgId,
          // null → undefined → NULL reference_id; never a non-UUID string.
          referenceId: args.telemetry.messageId ?? undefined,
          ...(args.chargeReason ? { reason: args.chargeReason } : {}),
          ...usage,
        });
      });
    } catch (err) {
      // Swallow — credit metering must never fail a capability call.
      logger.error({ err }, "generateObject credit charge failed");
    }
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
