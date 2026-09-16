/**
 * Whether `rotate_api_key` will replace a key — the whole answer, in one place.
 *
 * Two different things disqualify a key, and both have to live here, because
 * the answer is given twice for two audiences and a drift between them is the
 * same defect either way:
 *
 *   - `rotate_api_key` refuses, which is the guarantee. It is reachable from
 *     the API and MCP as well as the app, so a surface-side check is a courtesy
 *     and never the enforcement.
 *   - `list_api_keys` reports `rotatable`, so a page does not offer a control
 *     that can only fail.
 *
 * The two reasons:
 *
 *   - **A server-owned scope purpose.** A key minted by an enrollment or a
 *     login flow carries a reserved `purpose`, and the service that issued it
 *     owns its lifecycle (`rotate_agent_credential`, an operator enrollment,
 *     `oxagen login`). `create_api_key` refuses to mint one for the same
 *     reason — a caller must not self-assert an enrolment.
 *   - **An expiry that has passed.** `rotate_api_key` gives the replacement the
 *     rotated key's `expires_at`, so rotating an expired key revokes a key in
 *     the same transaction and mints one that is already expired, spending the
 *     one display of a secret nobody can use. The row is still there —
 *     `deleted_at` is null — so the not-found guard does not catch it.
 *
 * The clock is passed in rather than read here, so the caller decides which
 * instant it is judging against and a test does not depend on the clock the
 * suite runs on.
 */
import { requestsReservedCliSessionPurpose } from "@oxagen/auth/cli-auth";
import { requestsReservedAgentCredentialPurpose } from "@oxagen/oxagen/agent-credential";
import { requestsReservedStellaTelemetryPurpose } from "./stella-telemetry-enrollment";
import { requestsReservedTachoPurpose } from "./tacho-enrollment";

/** The fields of an api_keys row that decide whether it may be rotated. */
export interface RotationCandidate {
  readonly scope: unknown;
  readonly expiresAt: Date | null;
}

/**
 * Why a rotation is refused. `denied` is an authorization answer — this key is
 * not yours to rotate; `conflict` is a state answer — this key is finished.
 */
export type RotationRefusal =
  | { readonly kind: "denied"; readonly log: string; readonly denial: string }
  | {
      readonly kind: "conflict";
      readonly log: string;
      readonly reason: string;
      readonly message: string;
    };

interface ReservedPurpose {
  readonly matches: (scope: unknown) => boolean;
  readonly log: string;
  readonly denial: string;
}

const RESERVED_PURPOSES: readonly ReservedPurpose[] = [
  {
    matches: requestsReservedTachoPurpose,
    log: "api.key.rotate: rejected — reserved Tacho host purpose",
    denial: "Forbidden: enrolled Tacho host keys require operator rotation",
  },
  {
    matches: requestsReservedAgentCredentialPurpose,
    log: "api.key.rotate: rejected — reserved agent credential purpose",
    denial:
      "Forbidden: agent credentials rotate through rotate_agent_credential",
  },
  {
    matches: requestsReservedStellaTelemetryPurpose,
    log: "api.key.rotate: rejected — reserved Stella telemetry purpose",
    denial:
      "Forbidden: enrolled Stella telemetry keys require operator rotation",
  },
  {
    matches: requestsReservedCliSessionPurpose,
    log: "api.key.rotate: rejected — reserved CLI session purpose",
    denial: "Forbidden: a CLI session key is replaced by `oxagen login`",
  },
];

/** The refusal `rotate_api_key` owes this key at `now`, or null when it may be rotated. */
export function rotationRefusalFor(
  key: RotationCandidate,
  now: number,
): RotationRefusal | null {
  const reserved = RESERVED_PURPOSES.find((p) => p.matches(key.scope));
  if (reserved) {
    return { kind: "denied", log: reserved.log, denial: reserved.denial };
  }
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now) {
    return {
      kind: "conflict",
      log: "api.key.rotate: rejected — the key has expired",
      reason: "api_key_expired",
      message:
        "Conflict: this key has expired, and a rotation would copy the expiry that ended it onto the replacement. Create a new key instead.",
    };
  }
  return null;
}

/**
 * Whether `rotate_api_key` will replace this key at `now`. Revocation is not
 * affected: `revoke_api_key` ends a key whatever its purpose or its expiry.
 */
export function isRotatableKey(key: RotationCandidate, now: number): boolean {
  return rotationRefusalFor(key, now) === null;
}
