/**
 * What a turn spends advertising its tools, and whether a provider will take
 * them at all.
 *
 * Every turn sends the full tool list before anyone has said anything. Measured
 * on this repository's own surface it was 45,007 tokens across 271 tools —
 * 92.4% of the cacheable prefix, against 3,704 tokens of hand-written
 * instructions. Nobody could see that number without measuring it by hand, and
 * nothing checked it against what a provider will accept (oxagen#2611).
 *
 * Two separate jobs, and only the second can fail a turn.
 *
 * ## Measuring
 *
 * `bytes` is exact: the JSON of the schemas as they go on the wire.
 * `estimatedTokens` is bytes/4 and is called an estimate because that is what
 * it is — a tokenizer-free approximation, good to roughly the 4% two counting
 * methods differed by when #2611 measured it, and not a number to bill from.
 *
 * ## Refusing
 *
 * OpenAI accepts at most 128 tools in one request. A turn that sends more is
 * rejected by the provider, and until now nothing here looked: the failure
 * arrived as whatever the gateway chose to say, on a surface with no idea it
 * had asked for something impossible.
 *
 * Only providers with a published cap are listed. An unlisted provider is not
 * checked, which is the honest default — inventing a limit would refuse turns
 * that would have worked.
 */
import type { ToolSchema } from "@oxagen/stella-engine-client";

/**
 * Tools one request may advertise, per provider.
 *
 * Keyed by the gateway slug's provider half (`anthropic/claude-fable-5` →
 * `anthropic`). A provider absent from this table has no published cap that
 * this repository has verified, and is not checked.
 */
export const PROVIDER_TOOL_LIMITS: Readonly<Record<string, number>> = {
  openai: 128,
};

export interface ToolListSize {
  /** How many tools the turn advertises. */
  count: number;
  /** Exact bytes of the schemas as serialized for the wire. */
  bytes: number;
  /** bytes / 4. An estimate, and named one — there is no tokenizer here. */
  estimatedTokens: number;
}

/** The provider half of a gateway model slug, or undefined for a bare name. */
export function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/** Measure the tool list a turn is about to send. */
export function measureToolList(schemas: readonly ToolSchema[]): ToolListSize {
  const bytes = Buffer.byteLength(JSON.stringify(schemas), "utf8");
  return {
    count: schemas.length,
    bytes,
    estimatedTokens: Math.round(bytes / 4),
  };
}

/**
 * A turn refused before it was sent, because the provider cannot take this many
 * tools.
 *
 * Named and typed so a surface can say which provider, what the cap is, and how
 * many were asked for — rather than surfacing whatever the gateway returns for
 * a request it was never going to accept.
 */
export class ToolLimitExceededError extends Error {
  readonly provider: string;
  readonly limit: number;
  readonly count: number;

  constructor(provider: string, limit: number, count: number) {
    super(
      `[tools] ${provider} accepts at most ${limit} tools in one request; this turn advertises ${count}. ` +
        "Narrow the tool set for this surface — the request would be rejected by the provider, not by us.",
    );
    this.name = "ToolLimitExceededError";
    this.provider = provider;
    this.limit = limit;
    this.count = count;
  }
}

/**
 * Refuse a turn that asks for more tools than its provider accepts.
 *
 * Before the request, so the failure names the cause. A provider with no listed
 * cap, and a model with no provider prefix, both pass.
 */
export function assertWithinToolLimit(
  model: string | undefined,
  schemas: readonly ToolSchema[],
): void {
  const provider = providerOf(model);
  if (!provider) return;
  const limit = PROVIDER_TOOL_LIMITS[provider];
  if (limit === undefined) return;
  if (schemas.length > limit) {
    throw new ToolLimitExceededError(provider, limit, schemas.length);
  }
}
