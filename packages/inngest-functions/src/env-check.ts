/**
 * Inngest environment coherence checks.
 *
 * Production spent two weeks pointed at a developer's Inngest environment.
 * `/oxagen/production/INNGEST_SIGNING_KEY` held byte-for-byte the same
 * `signkey-test-…` value as a laptop's `.env.local`, while
 * `INNGEST_EVENT_KEY` belonged to a different environment altogether. Each
 * `inngest.send()` returned HTTP 200 with an event id, so the connect wizard,
 * the GitHub webhook receiver and the sync button all reported success — and
 * not one function ever ran, because the events landed in one environment and
 * the registered functions lived in another.
 *
 * A signing key names its own environment in plain text: Inngest issues
 * `signkey-prod-…` for a Production environment and `signkey-test-…` for every
 * other one. So the check below needs no network and would have failed on the
 * day the key was written. It cannot answer the other half — whether the event
 * key and the signing key resolve to the *same* environment — because an event
 * key carries no such marker. Only a round-trip settles that, which is what
 * `tools/scripts/inngest-verify.ts` does.
 */

/** Which Inngest environment class a signing key belongs to. */
export type InngestKeyPosture = "production" | "non_production" | "unknown";

const PRODUCTION_PREFIX = "signkey-prod-";
const NON_PRODUCTION_PREFIX = "signkey-test-";

/**
 * Classifies a signing key by its prefix. `unknown` covers a key that matches
 * neither prefix — a future format, or a value that is not a signing key at
 * all — and is never reported as a fault, because guessing wrong here would
 * block a deploy over a naming change at Inngest.
 */
export function signingKeyPosture(signingKey: string): InngestKeyPosture {
  if (signingKey.startsWith(PRODUCTION_PREFIX)) return "production";
  if (signingKey.startsWith(NON_PRODUCTION_PREFIX)) return "non_production";
  return "unknown";
}

/**
 * Returns the operator-facing complaint when this process is wired to an
 * Inngest environment it should not be using, or `null` when nothing is wrong.
 *
 * Only `NODE_ENV=production` is judged. Every other environment is expected to
 * hold a `signkey-test-…` key, and CI sets one deliberately.
 */
export function inngestEnvironmentComplaint(input: {
  nodeEnv: string;
  signingKey: string;
}): string | null {
  if (input.nodeEnv !== "production") return null;
  if (signingKeyPosture(input.signingKey) !== "non_production") return null;

  return (
    "INNGEST_SIGNING_KEY is a non-production Inngest key (signkey-test-…) but NODE_ENV=production. " +
    "Events will be accepted and no function will run, because the functions are registered in a " +
    "different environment than the one INNGEST_EVENT_KEY sends to. Set both INNGEST_EVENT_KEY and " +
    "INNGEST_SIGNING_KEY from the same Inngest Production environment, redeploy, then re-sync the app " +
    "(PUT /api/inngest) and confirm with `pnpm inngest:verify`."
  );
}
