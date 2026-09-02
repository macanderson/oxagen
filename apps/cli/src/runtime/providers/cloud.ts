/**
 * Cloud model providers (anthropic, openai) over the Vercel AI Gateway.
 *
 * Both talk to the same gateway the rest of the CLI uses — models are plain
 * gateway slugs (`vendor/model`) resolved with `AI_GATEWAY_API_KEY`, or, when
 * only `ANTHROPIC_API_KEY` is present, anthropic/* slugs resolve directly
 * against the Anthropic API (see `agent/env.ts` + `agent/anthropic-direct.ts`).
 * The two vendor classes are thin: they exist so the registry
 * exposes concrete `anthropic` and `openai` providers (deliverable 2) that
 * differ in vendor labelling and cost grouping, while sharing one code path.
 *
 * Requirement 6 (offline): cloud completions must fail with a clear message when
 * offline, without crashing the coordinator. `complete` translates network
 * errors into {@link OfflineError}; the on-device coordinator keeps running.
 */
import { generateText } from "ai";
import {
  credentialSupportsModel,
  resolveAiCredential,
} from "../../agent/env.js";
import { estimateCostUsd } from "../../agent/rate-card.js";
import { estimateInputTokens, estimateTokens } from "../tokens.js";
import type {
  CloudModelEntry,
  CompletionRequest,
  CompletionResult,
  ModelCapabilities,
  ModelProvider,
} from "../types.js";

/** Thrown when a cloud call fails because the machine appears to be offline. */
export class OfflineError extends Error {
  constructor(model: string, cause?: unknown) {
    super(
      `Cannot reach the model gateway for "${model}" — you appear to be offline. ` +
        `On-device coordination still works; cloud workers and the judge need a network.`,
    );
    this.name = "OfflineError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when no usable credential can be resolved for a cloud call. */
export class MissingCredentialError extends Error {
  constructor(model: string) {
    super(
      `No AI credential for "${model}". Set AI_GATEWAY_API_KEY (any vendor) or ` +
        `ANTHROPIC_API_KEY (Anthropic models only), run \`oxagen config\`, or add ` +
        `one to a nearby .env.local.`,
    );
    this.name = "MissingCredentialError";
  }
}

/** The AI-SDK call, injectable so tests never hit the gateway. */
export type GenerateFn = (args: {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}) => Promise<{
  text: string;
  usage: { inputTokens?: number; outputTokens?: number };
}>;

/**
 * Standalone fallback for a `complete()` call with no injected `generate` — used
 * only by tests and out-of-engine one-shot inspection. The LIVE path (the
 * coordinator seam in `agent/adapters/coordinator.ts`) injects a METERED
 * `generate` built over `createMeteredAi`/the gateway port, so on-path cloud
 * completions emit metering + honor BYOK, never this raw `ai` call. Keeping the
 * raw default confined to non-engine use is the "all LLM calls through
 * @oxagen/ai" rule (this module can't import the metered port without a
 * runtime→agent cycle, so the caller injects it).
 */
const defaultGenerate: GenerateFn = (args) =>
  generateText({
    model: args.model,
    messages: args.messages,
    // Coordinator/judge requests carry their system prompt as a system-role
    // message; AI SDK v7 rejects that in `messages` unless explicitly allowed.
    allowSystemInMessages: true,
    ...(args.maxOutputTokens !== undefined
      ? { maxOutputTokens: args.maxOutputTokens }
      : {}),
    ...(args.temperature !== undefined
      ? { temperature: args.temperature }
      : {}),
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  }) as ReturnType<GenerateFn>;

export interface CloudProviderDeps {
  generate?: GenerateFn;
  /**
   * Resolve/ensure a credential usable for this provider's model. Returns null
   * when none is available (missing keys, or the model's vendor is unreachable
   * with the resolved credential).
   */
  resolveKey?: () => string | null;
}

/** Detect the "you're offline / DNS failed / connection refused" family. */
function isNetworkError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (
    code &&
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENETUNREACH",
    ].includes(code)
  ) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("getaddrinfo") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused")
  );
}

/** Shared gateway-backed cloud provider. Vendor subclasses specialise labelling. */
export class GatewayCloudProvider implements ModelProvider {
  protected readonly generate: GenerateFn;
  protected readonly resolveKey: () => string | null;

  constructor(
    protected readonly registryId: string,
    protected readonly entry: CloudModelEntry,
    deps: CloudProviderDeps = {},
  ) {
    this.generate = deps.generate ?? defaultGenerate;
    // Default credential check is model-aware: a gateway key runs any vendor,
    // an ANTHROPIC_API_KEY-only setup runs only anthropic/* slugs — so e.g.
    // the OpenAI judge reports unavailable instead of failing mid-call.
    this.resolveKey =
      deps.resolveKey ??
      (() => {
        const credential = resolveAiCredential();
        if (!credential) return null;
        return credentialSupportsModel(credential, this.entry.slug)
          ? credential.key
          : null;
      });
  }

  id(): string {
    return this.registryId;
  }

  /**
   * The concrete Vercel AI Gateway slug (`vendor/model`) this provider resolves
   * to. The coordinator seam hands this to the engine's shared metered port as
   * the per-call `model`, so a cloud coordinator streams natively (tools +
   * streaming intact) instead of being funnelled through single-shot `complete`.
   */
  slug(): string {
    return this.entry.slug;
  }

  kind(): "cloud" {
    return "cloud";
  }

  async isAvailable(): Promise<boolean> {
    return this.resolveKey() !== null;
  }

  async ensureReady(): Promise<void> {
    if (this.resolveKey() === null)
      throw new MissingCredentialError(this.registryId);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    await this.ensureReady();
    let out: Awaited<ReturnType<GenerateFn>>;
    try {
      out = await this.generate({
        model: this.entry.slug,
        messages: req.messages,
        ...(req.maxOutputTokens !== undefined
          ? { maxOutputTokens: req.maxOutputTokens }
          : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...(req.signal ? { abortSignal: req.signal } : {}),
      });
    } catch (err) {
      if (isNetworkError(err)) throw new OfflineError(this.registryId, err);
      throw err;
    }
    const usage = {
      inputTokens: out.usage.inputTokens ?? estimateInputTokens(req),
      outputTokens: out.usage.outputTokens ?? estimateTokens(out.text),
    };
    return {
      text: out.text,
      usage,
      model: this.entry.slug,
      kind: "cloud",
      costUsd: estimateCostUsd(this.entry.slug, usage),
    };
  }

  estimateCost(req: CompletionRequest): { tokens: number; usd: number } {
    const inputTokens = estimateInputTokens(req);
    const outputTokens = req.maxOutputTokens ?? 1024;
    return {
      tokens: inputTokens + outputTokens,
      usd: estimateCostUsd(this.entry.slug, { inputTokens, outputTokens }),
    };
  }

  capabilities(): ModelCapabilities {
    return {
      id: this.registryId,
      kind: "cloud",
      vendor: this.entry.vendor,
      contextWindow: this.entry.contextWindow,
      offline: false,
      tools: this.entry.tools,
    };
  }
}

/** Concrete Anthropic-vendor cloud provider. */
export class AnthropicProvider extends GatewayCloudProvider {}

/** Concrete OpenAI-vendor cloud provider (default judge model). */
export class OpenAiProvider extends GatewayCloudProvider {}
