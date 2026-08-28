import pino from "pino";
import Anthropic from "@anthropic-ai/sdk";
import {
  hashPrompt,
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits, providerCostUsdMicros } from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.batch" },
});

// ---------------------------------------------------------------------------
// Anthropic Message Batches — background inference at half price.
//
// The Vercel AI Gateway does NOT proxy the Message Batches endpoint (it is an
// Anthropic first-party async API), so this path goes direct to Anthropic with
// the existing key patterns: ANTHROPIC_API_KEY. Model ids are BARE Anthropic
// ids (e.g. "claude-haiku-4-5") — never gateway `creator/model` slugs.
//
// Metering discipline mirrors the synchronous helpers: on completion we emit
// one token_usage row per succeeded request and charge credits, so batched
// spend lands in the same billing record as everything else.
// ---------------------------------------------------------------------------

/** A single request in a batch, keyed by a caller-chosen stable id. */
export interface BatchRequestInput {
  /**
   * Stable per-request key. Results arrive in ANY order — always match on this,
   * never on position. Must be unique within the batch.
   */
  customId: string;
  /** System instruction (optional). */
  system?: string;
  /** Single-turn user prompt. */
  prompt: string;
  /** Max output tokens for this request. */
  maxTokens: number;
  /** Sampling temperature. Defaults to 0 for deterministic background work. */
  temperature?: number;
}

/** Telemetry/attribution context for a batch. */
export interface BatchTelemetry {
  orgId: string;
  workspaceId: string;
  surface: Surface;
}

export interface SubmitBatchArgs {
  /** Bare Anthropic model id (e.g. "claude-haiku-4-5"). */
  model: string;
  requests: BatchRequestInput[];
  telemetry: BatchTelemetry;
  /**
   * Injectable Anthropic client — defaults to a client reading ANTHROPIC_API_KEY
   * from the environment. Injected in tests to avoid network + env.
   */
  client?: Pick<
    Anthropic["messages"]["batches"],
    "create" | "retrieve" | "results"
  >;
}

export interface SubmitBatchResult {
  /** Provider batch id (`msgbatch_…`) — poll with this. */
  batchId: string;
  /** Provider processing status at submit time. */
  status: string;
  requestCount: number;
}

/** One decoded batch result, matched to its request by `customId`. */
export interface BatchResultItem {
  customId: string;
  type: "succeeded" | "errored" | "canceled" | "expired";
  /** Present only when `type === "succeeded"`. */
  text?: string;
  usage?: {
    /**
     * INCLUSIVE input total (fresh + cache reads + cache writes) — normalized
     * from the raw Anthropic batch usage (which is additive: `input_tokens`
     * excludes cache tokens) to match the platform's rate-card convention, where
     * fresh = inputTokens - cachedTokens - cacheWriteTokens.
     */
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
  };
  /** Present when `type === "errored"`. */
  error?: string;
}

export interface PollBatchResult {
  batchId: string;
  /** Provider processing status: in_progress | ended | canceling. */
  status: string;
  /** true once the provider status is "ended". */
  ended: boolean;
  counts: {
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
    processing: number;
  };
  /** Decoded results — only populated when `ended`. */
  results: BatchResultItem[];
}

function anthropicClient(): Anthropic {
  // Anthropic SDK reads ANTHROPIC_API_KEY from the environment. Fail loudly if
  // it is absent — a batch cannot be routed through the gateway.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for the Message Batches API — the AI " +
        "Gateway does not proxy batch endpoints. Set ANTHROPIC_API_KEY.",
    );
  }
  return new Anthropic();
}

/**
 * Submit a batch of deterministic inference requests. Returns the provider
 * batch id to poll. Does not wait — callers poll via {@link pollBatch}.
 */
export async function submitBatch(
  args: SubmitBatchArgs,
): Promise<SubmitBatchResult> {
  if (args.requests.length === 0) {
    throw new Error("submitBatch: requests must be non-empty");
  }
  const client = args.client ?? anthropicClient().messages.batches;

  const batch = await client.create({
    requests: args.requests.map((r) => ({
      custom_id: r.customId,
      params: {
        model: args.model,
        max_tokens: r.maxTokens,
        temperature: r.temperature ?? 0,
        ...(r.system ? { system: r.system } : {}),
        messages: [{ role: "user" as const, content: r.prompt }],
      },
    })),
  });

  logger.info(
    {
      batchId: batch.id,
      requestCount: args.requests.length,
      surface: args.telemetry.surface,
    },
    "submitBatch: batch submitted",
  );

  return {
    batchId: batch.id,
    status: batch.processing_status,
    requestCount: args.requests.length,
  };
}

export interface PollBatchArgs {
  batchId: string;
  model: string;
  telemetry: BatchTelemetry;
  client?: Pick<
    Anthropic["messages"]["batches"],
    "create" | "retrieve" | "results"
  >;
  /**
   * When true (default), emit token_usage rows and charge credits for every
   * succeeded result once the batch has ended. Set false if an outer system
   * owns metering.
   */
  meter?: boolean;
}

/**
 * Poll a batch once. When the provider status is "ended", decodes every result
 * and (unless `meter: false`) emits token_usage + charges credits for the
 * succeeded ones — so batched spend is metered exactly like synchronous calls.
 */
export async function pollBatch(args: PollBatchArgs): Promise<PollBatchResult> {
  const client = args.client ?? anthropicClient().messages.batches;
  const batch = await client.retrieve(args.batchId);

  const counts = {
    succeeded: batch.request_counts?.succeeded ?? 0,
    errored: batch.request_counts?.errored ?? 0,
    canceled: batch.request_counts?.canceled ?? 0,
    expired: batch.request_counts?.expired ?? 0,
    processing: batch.request_counts?.processing ?? 0,
  };
  const ended = batch.processing_status === "ended";

  if (!ended) {
    return {
      batchId: args.batchId,
      status: batch.processing_status,
      ended: false,
      counts,
      results: [],
    };
  }

  const results: BatchResultItem[] = [];
  const stream = await client.results(args.batchId);
  for await (const entry of stream) {
    const customId = entry.custom_id;
    const result = entry.result;
    if (result.type === "succeeded") {
      const message = result.message;
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      // Raw Anthropic batch usage is ADDITIVE — `input_tokens` is the uncached
      // remainder; cache reads/writes are separate counts. Normalize to the
      // platform's INCLUSIVE convention (see the interface) so the rate card's
      // `fresh = inputTokens - reads - writes` recovers the true fresh count and
      // prices cache writes at the provider premium.
      const cacheReadTokens = message.usage?.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = message.usage?.cache_creation_input_tokens ?? 0;
      const usage = {
        inputTokens:
          (message.usage?.input_tokens ?? 0) +
          cacheReadTokens +
          cacheWriteTokens,
        outputTokens: message.usage?.output_tokens ?? 0,
        cachedTokens: cacheReadTokens,
        cacheWriteTokens,
      };
      results.push({ customId, type: "succeeded", text, usage });
    } else if (result.type === "errored") {
      results.push({
        customId,
        type: "errored",
        error: JSON.stringify(result.error),
      });
    } else {
      results.push({ customId, type: result.type });
    }
  }

  if (args.meter !== false) {
    await meterBatchResults(args.model, args.telemetry, results).catch(
      (err: unknown) => {
        // Metering is best-effort — a failure must not fail the poll.
        logger.error(
          { err, batchId: args.batchId },
          "pollBatch metering failed",
        );
      },
    );
  }

  logger.info({ batchId: args.batchId, counts }, "pollBatch: batch ended");
  return {
    batchId: args.batchId,
    status: batch.processing_status,
    ended: true,
    counts,
    results,
  };
}

/**
 * Emit one token_usage row per succeeded result and charge credits for the
 * aggregate. Mirrors the synchronous helpers' metering so ClickHouse and the
 * credit ledger see batched spend identically.
 */
async function meterBatchResults(
  model: string,
  telemetry: BatchTelemetry,
  results: BatchResultItem[],
): Promise<void> {
  const provider = providerFromModelId(model);
  const succeeded = results.filter((r) => r.type === "succeeded" && r.usage);
  if (succeeded.length === 0) return;

  const now = new Date().toISOString();
  const rows = await Promise.all(
    succeeded.map(async (r) => {
      const inputTokens = r.usage?.inputTokens ?? 0;
      const outputTokens = r.usage?.outputTokens ?? 0;
      const cachedTokens = r.usage?.cachedTokens ?? 0;
      const cacheWriteTokens = r.usage?.cacheWriteTokens ?? 0;
      const costUsdMicros = providerCostUsdMicros({
        model,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
      });
      const promptHash = await hashPrompt(r.customId);
      return {
        row: {
          execution_step_id: null,
          org_id: telemetry.orgId,
          workspace_id: telemetry.workspaceId,
          model,
          provider,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cached_tokens: cachedTokens,
          cache_write_tokens: cacheWriteTokens,
          cost_usd_micros: costUsdMicros,
          duration_ms: 0,
          surface: telemetry.surface,
          prompt_hash: promptHash,
          created_at: now,
        },
        usage: {
          model,
          inputTokens,
          outputTokens,
          cachedTokens,
          cacheWriteTokens,
        },
      };
    }),
  );

  try {
    await insertTokenUsage(rows.map((r) => r.row));
  } catch (err) {
    logger.error({ err }, "batch token_usage write failed");
  }

  // Charge credits for the aggregate batch spend. Rebuild the tenant scope from
  // the trusted telemetry context when none is active (background workers).
  const capturedScope: TenantScope = getScope() ?? {
    orgId: telemetry.orgId,
    workspaceId: telemetry.workspaceId,
  };
  try {
    await runInTenantScope(capturedScope, async () => {
      for (const r of rows) {
        await chargeUsageCredits({ orgId: telemetry.orgId, ...r.usage });
      }
    });
  } catch (err) {
    logger.error({ err }, "batch credit charge failed");
  }
}
