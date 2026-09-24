/**
 * The API-key scope a Tacho host carries, and the guard that keeps the
 * generic key-management capabilities from minting it (the same trust
 * boundary as the Stella telemetry enrollment: a caller must not be able to
 * self-assert that its key is an enrolled host).
 */
import { z } from "zod";

// Both purposes are declared in @oxagen/database/member-lifecycle, beside the
// host revocation that selects on them, so a member removal outside this
// package names the same literals.
import {
  TACHO_GATEWAY_SCOPE_PURPOSE,
  TACHO_HOST_SCOPE_PURPOSE,
} from "@oxagen/database/member-lifecycle";

export { TACHO_GATEWAY_SCOPE_PURPOSE, TACHO_HOST_SCOPE_PURPOSE };

export const tachoHostApiKeyScopeSchema = z
  .object({
    purpose: z.literal(TACHO_HOST_SCOPE_PURPOSE),
    host_enrollment_id: z.string().regex(/^tch_[a-z0-9]{22}$/),
  })
  .strict();

export type TachoHostApiKeyScope = z.output<typeof tachoHostApiKeyScopeSchema>;

export function requestsReservedTachoPurpose(scope: unknown): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === TACHO_HOST_SCOPE_PURPOSE
  );
}

/**
 * The same question for the GATEWAY purpose, deliberately a separate predicate.
 *
 * `api.key.revoke` and `api.key.rotate` refuse a reserved purpose only when the
 * capability they name achieves what the refused operation was for, and their
 * module comment is explicit that being server-owned is NOT that test and that
 * reasoning about "the set of server-owned purposes" is how two wrong refusals
 * got in. Widening `requestsReservedTachoPurpose` would silently change what
 * those callers refuse, on exactly that rejected reasoning and without anyone
 * reading the line that changed. Two predicates, each answerable to its own
 * callers, is the point.
 *
 * Nothing legitimately self-asserts this purpose: enrollment inserts the
 * gateway key directly (`lib/tacho-host-enroll.ts`), never through
 * `create_api_key`, so refusing it removes no capability from anyone.
 *
 * ## Its three callers, and why each one's answer is now unambiguous
 *
 * `create_api_key` — MINTING. Nothing to weigh: the purpose is the server's
 * and a caller asserting it is asserting something untrue.
 *
 * `revoke_api_key` — names `revoke_tacho_enrollment`, which retires the
 * gateway key *because of this change*: `retireEnrollmentKeys` selects
 * `purpose IN (tacho_host_v1, tacho_gateway_v1)` (discussion_r4036214055), so
 * the named path now does the job. It did not before, and a refusal pointing
 * at it then would have been an instruction to do nothing.
 *
 * `rotate_api_key` — names the same path plus re-enrollment. Rotating a
 * gateway key here hands the operator a credential with nowhere to put it: the
 * daemon reads it from its enrollment record, so the local gateway serves
 * nothing afterwards. What the operator wanted is a fresh credential on a
 * working host, and that is revoke-enrollment then re-enroll — also only clean
 * as of this change.
 *
 * Each refusal landed in the PR that made its named path true, rather than
 * being correct by merge order. Correctness that depends on which branch
 * merges first is not correctness.
 */
export function requestsReservedTachoGatewayPurpose(scope: unknown): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === TACHO_GATEWAY_SCOPE_PURPOSE
  );
}
