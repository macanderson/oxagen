/**
 * Which API-key scope purposes are server-owned, in one list.
 *
 * A key minted by an enrollment or a login flow carries a reserved `purpose` in
 * its scope, and `rotate_api_key` refuses to replace one: the service that
 * issued it owns its lifecycle (`rotate_agent_credential`, an operator
 * enrollment, `oxagen login`). `create_api_key` refuses to mint one for the
 * same reason — a caller must not be able to self-assert an enrolment.
 *
 * The list lives here because two capabilities need the same answer and must
 * not disagree about it: `rotate_api_key` refuses, and `list_api_keys` reports
 * `rotatable` so a page does not offer a rotation that can only fail. A fifth
 * purpose is added once, here, and both follow.
 */
import { requestsReservedCliSessionPurpose } from "@oxagen/auth/cli-auth";
import { requestsReservedAgentCredentialPurpose } from "@oxagen/oxagen/agent-credential";
import { requestsReservedStellaTelemetryPurpose } from "./stella-telemetry-enrollment";
import { requestsReservedTachoPurpose } from "./tacho-enrollment";

export interface ReservedKeyPurpose {
  /** Whether a stored scope carries this purpose. */
  readonly matches: (scope: unknown) => boolean;
  /** What the rotate refusal logs. */
  readonly log: string;
  /** What the rotate refusal tells the caller, naming who does own the rotation. */
  readonly denial: string;
}

export const RESERVED_KEY_PURPOSES: readonly ReservedKeyPurpose[] = [
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

/** The reserved purpose a stored scope carries, or null for a key anyone may rotate. */
export function reservedKeyPurposeOf(
  scope: unknown,
): ReservedKeyPurpose | null {
  return RESERVED_KEY_PURPOSES.find((p) => p.matches(scope)) ?? null;
}

/**
 * Whether `rotate_api_key` will replace this key. Revocation is not affected:
 * `revoke_api_key` ends a key whatever its purpose.
 */
export function isRotatableKeyScope(scope: unknown): boolean {
  return reservedKeyPurposeOf(scope) === null;
}
