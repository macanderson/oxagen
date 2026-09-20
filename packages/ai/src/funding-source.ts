/**
 * Who pays the vendor for an organisation's model calls, and on which key
 * (ADR-053 §2, extended by ADR-131).
 *
 * One answer per organisation, resolved once per turn and threaded through
 * `selectModel` (which key the client is built on) and the three metered call
 * paths (whether the tokens are charged). The rule the two halves implement
 * together is the one ADR-053 §3 states: a token is billed only when Oxagen
 * paid for it.
 *
 * THOSE TWO HALVES ARE NOW INDEPENDENT, which is the whole of ADR-131. Before
 * it, "has a key" and "the customer pays" were the same fact, so one field
 * answered both. Now Oxagen mints a key per organisation on its own OpenRouter
 * account, and a turn on that key is a turn the customer did not pay for:
 *
 *   fundedBy   who is invoiced, and therefore whether credits are charged.
 *   modelKey   which key the client is built on, or undefined for the shared
 *              key in the process environment.
 *
 *   fundedBy: "org"      modelKey: the customer's own key. Nothing billed.
 *   fundedBy: "platform" modelKey: the key Oxagen minted for them. Billed.
 *   fundedBy: "platform" modelKey: undefined. The shared key. Billed.
 *
 * The third row is what every organisation ran on before ADR-131 and what any
 * organisation falls back to when its own key cannot be resolved, so the two
 * platform rows must bill identically. They do: metering reads `fundedBy` and
 * never `modelKey`.
 *
 * `modelKey` is named for what it is rather than `credential`, and the rename
 * is load-bearing. Callers used to write
 * `funding.fundedBy === "org" ? { credential: funding.credential } : {}` — a
 * spread that is silently wrong the moment a platform-funded turn has a key,
 * because it drops that key and quietly spends the shared one instead. The
 * rename turns every one of those sites into a type error rather than a
 * reconciliation gap nobody sees. Pass `funding.modelKey` through
 * unconditionally.
 *
 * Server-only: reads through `@oxagen/database`, which opens KMS envelopes.
 * Must be called inside a tenant scope.
 */
import { loadModelCredential } from "@oxagen/database/model-credential";
import { loadAssistantModelKey } from "@oxagen/database/assistant-model-key";
import type { ModelCredential } from "./models";

/**
 * `platform`: Oxagen's key pays the vendor and the tokens are billed to the
 * organisation as assistant usage under its spend cap. Which of Oxagen's keys
 * paid — the shared one or the one minted for this organisation — is
 * `modelKey`, and does not change the billing.
 * `org`: the organisation's own key pays, and Oxagen bills nothing for tokens.
 */
export type TurnFunding = "platform" | "org";

export type ModelFundingSource =
  /**
   * Oxagen pays. `modelKey` is the organisation's own minted key when it has
   * one, and undefined when the turn runs on the shared key.
   */
  | { fundedBy: "platform"; modelKey?: ModelCredential; keyHint?: string }
  /** The customer pays, on the key they brought. A key is guaranteed here. */
  | { fundedBy: "org"; modelKey: ModelCredential; keyHint: string };

/** The answer for an organisation with no key of any kind: the shared key. */
export const PLATFORM_FUNDING: ModelFundingSource = { fundedBy: "platform" };

/**
 * Resolve the organisation's funding source.
 *
 * Asked in one order, for one reason: a key the customer brought outranks a
 * key Oxagen minted for them. An organisation that adopts BYOK stops being
 * billed for tokens from that moment, and a minted key left behind must not
 * keep spending Oxagen's money underneath it. The minted key is not deleted
 * when this happens — its past usage is still what last quarter's invoice
 * reconciles against — it simply stops being reached.
 *
 * Two failures are answered as a key lower down the order, and logged inside
 * the resolver that saw them: an envelope that cannot be opened, and a row
 * marked disabled. A turn that fails on a key the customer cannot see reads to
 * them as the product being broken, and the shared key is the state every
 * organisation started in.
 *
 * A failed database read is not answered; it propagates and the turn fails.
 * Guessing "platform" during an outage would move an organisation that has
 * its own key onto Oxagen's billed key, which is the one direction this seam
 * must never err in. A caller that catches this and substitutes
 * PLATFORM_FUNDING has reintroduced that error.
 */
export async function resolveModelFundingSource(
  orgId: string,
): Promise<ModelFundingSource> {
  const brought = await loadModelCredential(orgId);
  if (brought) {
    return {
      fundedBy: "org",
      modelKey: {
        provider: brought.provider,
        apiKey: brought.apiKey,
        digest: brought.digest,
        baseUrl: brought.baseUrl,
        modelMap: brought.modelMap,
      },
      keyHint: brought.keyHint,
    };
  }

  const minted = await loadAssistantModelKey(orgId);
  if (minted) {
    return {
      fundedBy: "platform",
      modelKey: {
        provider: minted.provider,
        apiKey: minted.apiKey,
        digest: minted.digest,
        // A minted key is always a routed OpenRouter key on Oxagen's own
        // account, so there is no customer endpoint to spell and no per-tier
        // remapping to do: the platform tier ids resolve on it unchanged,
        // which is what makes this key a drop-in for the shared one.
        baseUrl: null,
        modelMap: null,
      },
      keyHint: minted.keyHint,
    };
  }

  return PLATFORM_FUNDING;
}
