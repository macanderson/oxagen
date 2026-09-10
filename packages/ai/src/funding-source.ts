/**
 * Who pays the vendor for an organisation's model calls (ADR-053 §2).
 *
 * One answer per organisation, resolved once per turn and threaded through
 * `selectModel` (which key the client is built on) and the three metered call
 * paths (whether the tokens are charged). The rule the two halves implement
 * together is the one ADR-053 §3 states: a token is billed only when Oxagen
 * paid for it.
 *
 * Server-only: reads the organisation's credential through
 * `@oxagen/database/model-credential`, which opens the KMS envelope. Must be
 * called inside a tenant scope.
 */
import { loadModelCredential } from "@oxagen/database/model-credential";
import type { ModelCredential } from "./models";

/**
 * `platform`: Oxagen's key pays the vendor and the tokens are billed to the
 * organisation as assistant usage under its spend cap.
 * `org`: the organisation's own key pays, and Oxagen bills nothing for tokens.
 */
export type TurnFunding = "platform" | "org";

export type ModelFundingSource =
  | { fundedBy: "platform"; credential?: undefined; keyHint?: undefined }
  | { fundedBy: "org"; credential: ModelCredential; keyHint: string };

/** The answer for an organisation with no stored key. */
export const PLATFORM_FUNDING: ModelFundingSource = { fundedBy: "platform" };

/**
 * Resolve the organisation's funding source.
 *
 * Two failures are answered as the platform key, and logged inside the
 * resolver: an envelope that cannot be opened, and a row marked disabled. A
 * turn that fails on a customer's own key reads to them as their key being
 * broken, and the platform key is the state every organisation starts in.
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
  const stored = await loadModelCredential(orgId);
  if (!stored) return PLATFORM_FUNDING;
  return {
    fundedBy: "org",
    credential: {
      provider: stored.provider,
      apiKey: stored.apiKey,
      digest: stored.digest,
    },
    keyHint: stored.keyHint,
  };
}
