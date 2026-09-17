// Whether a credential can still be presented. Two fields on the row disqualify
// it and both are checked in the same order the server checks them, because a
// page that reads one of them prints "active" over a credential that is refused
// at every use.
//
// The refusals this mirrors:
//   - an API key: `packages/auth/src/resolvers/api-key.ts:144-145` returns
//     `expired` for a key past `expires_at`, and the row is gone from the
//     resolver's select once `deleted_at` is set;
//   - a Tacho host enrollment: `packages/handlers/src/lib/tacho-host.ts:110-115`
//     refuses a revoked enrollment and then an expired one.
//
// Revocation is recorded, expiry is judged, so the caller passes the instant it
// judges against rather than this module reading a clock: a component must not
// call `Date.now()` during render, and a test must not depend on the clock the
// suite runs on.

export type CredentialState = "live" | "expired" | "revoked";

/** A row with the two fields that can disqualify it; anything else is ignored. */
export interface CredentialLifetime {
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export function credentialState(
  credential: CredentialLifetime,
  now: number,
): CredentialState {
  if (credential.revokedAt !== null) return "revoked";
  if (credential.expiresAt !== null && Date.parse(credential.expiresAt) <= now)
    return "expired";
  return "live";
}
