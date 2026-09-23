/**
 * Which provider serves the platform's own language-model calls.
 *
 * `OXAGEN_MODEL_PROVIDER` is the one switch (see `languageProvider` in
 * ./models): the gateway by default, or OpenRouter where an operator opted
 * out. The env registry says it is never an automatic fallback.
 *
 * ADR-131's minted keys are OpenRouter keys. Building a client on one moves
 * the organisation's turns off the gateway, so a minted key may serve only on
 * a deployment whose platform key is already an OpenRouter key. On a gateway
 * deployment the minted key is neither minted nor resolved (ADR-131 §9). Both
 * sites ask this module, so the coupling has one home.
 */
import { requireEnv } from "@oxagen/config/env";

export type PlatformLanguageProvider = "gateway" | "openrouter";

/** The provider `OXAGEN_MODEL_PROVIDER` names, read fresh on every call. */
export function platformLanguageProvider(): PlatformLanguageProvider {
  const { OXAGEN_MODEL_PROVIDER } = requireEnv([
    "OXAGEN_MODEL_PROVIDER",
  ] as const);
  return OXAGEN_MODEL_PROVIDER === "openrouter" ? "openrouter" : "gateway";
}

/**
 * True where a key minted on Oxagen's OpenRouter account can serve a turn
 * without changing which vendor the platform routes through.
 */
export function mintedKeysServeHere(): boolean {
  return platformLanguageProvider() === "openrouter";
}
