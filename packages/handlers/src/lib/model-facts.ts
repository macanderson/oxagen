/**
 * Two facts about a model that its id already carries and a run record has
 * never written down: which vendor served it, and which capability class
 * inside that vendor's family it belongs to.
 *
 * `tacho.sessions` has carried `model_initial` and `model_final` since the
 * table was created, and both hold a bare vendor model id such as
 * `claude-haiku-4-5-20251001`. Neither a provider nor a class has ever been
 * stored beside them. Both are derivable from the id, so neither needs a new
 * column, a new migration, or a round trip to the host.
 *
 * Why they are worth deriving. "Which model ran this" is the first question a
 * FinOps or security reader asks of a run, and a bare dated id answers it
 * only for someone who already knows the vendor's naming. The provider
 * answers who served the call, which is the axis vendor-neutral BYOK is
 * governed on. The class answers how capable the model was, which is the axis
 * spend is argued on.
 *
 * Provider is not derived a second time here. `providerFromModelId` in
 * `@oxagen/telemetry` has decided the vendor for every metered call this
 * platform has made, and a second table would drift from it: a Run page and
 * the meter would then disagree about who served the same call. This module
 * only narrows its empty-string miss to `undefined`.
 *
 * Tier here means the capability class the vendor names inside its own family
 * (haiku, sonnet, opus; mini, nano; flash, pro). It is not a billing tier, and
 * it is not Oxagen's white-labelled fast/balanced/precise, which is a
 * deployment choice and not a property of the id. An id that names no class,
 * such as a plain `gpt-5`, returns undefined, and so does a word this table
 * does not know, because a wrong class on a run record is worse than an
 * absent one.
 */
import { providerFromModelId } from "@oxagen/telemetry";

/** A model as a run row reports it: the recorded id, plus what it implies. */
export type ModelFacts = {
  /** The id exactly as the record holds it. */
  id: string;
  provider: string | null;
  tier: string | null;
};

/**
 * The vendor `providerFromModelId` reads out of the id, or undefined. That
 * function answers "" for an id it does not recognise, which is a miss and
 * not a vendor named "".
 */
export function modelProviderOf(modelId: string): string | undefined {
  const provider = providerFromModelId(modelId);
  return provider.length === 0 ? undefined : provider;
}

/**
 * The model's own segment of the id, lowercased: the part after the gateway's
 * `provider/model` slash or the AI SDK's `provider:model` colon, or the whole
 * id when it carries neither.
 */
function modelSegment(modelId: string): string {
  const id = modelId.toLowerCase().trim();
  const cut = Math.max(id.lastIndexOf("/"), id.lastIndexOf(":"));
  return cut === -1 ? id : id.slice(cut + 1);
}

/**
 * Classes spelled across more than one token, checked before the single-token
 * table so `gemini-2.5-flash-lite` does not read as `flash`.
 */
const COMPOUND_TIERS: readonly (readonly [needle: string, tier: string])[] = [
  ["flash-lite", "flash-lite"],
];

/**
 * The capability classes this table is willing to name, by the token that
 * names them. Anthropic, OpenAI and Google only: a vendor absent from this
 * table means no class this codebase has confirmed, never no class.
 */
const TIER_WORDS: Readonly<Record<string, string>> = {
  // Anthropic
  haiku: "haiku",
  sonnet: "sonnet",
  opus: "opus",
  fable: "fable",
  // OpenAI
  mini: "mini",
  nano: "nano",
  // Google, and OpenAI's `pro` line
  flash: "flash",
  pro: "pro",
  ultra: "ultra",
};

/**
 * The capability class the id names, or undefined. Tokens are matched whole,
 * so a class word buried inside a longer word is not a match.
 */
export function modelTierOf(modelId: string): string | undefined {
  const name = modelSegment(modelId);
  if (name.length === 0) return undefined;
  for (const [needle, tier] of COMPOUND_TIERS)
    if (name.includes(needle)) return tier;
  for (const token of name.split(/[^a-z0-9]+/)) {
    if (Object.hasOwn(TIER_WORDS, token)) return TIER_WORDS[token];
  }
  return undefined;
}

/**
 * A recorded model id as a run row reports it, or null when the record holds
 * no id. A recognised id keeps its unrecognised halves null rather than
 * guessing either one.
 */
export function modelFactsOf(modelId: string | null | undefined): ModelFacts | null {
  if (modelId === null || modelId === undefined) return null;
  const id = modelId.trim();
  if (id.length === 0) return null;
  return {
    id,
    provider: modelProviderOf(id) ?? null,
    tier: modelTierOf(id) ?? null,
  };
}
