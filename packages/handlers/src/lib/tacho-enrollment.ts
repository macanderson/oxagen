/**
 * The API-key scope a Tacho host carries, and the guard that keeps the
 * generic key-management capabilities from minting it (the same trust
 * boundary as the Stella telemetry enrollment: a caller must not be able to
 * self-assert that its key is an enrolled host).
 */
import { z } from "zod";

export const TACHO_HOST_SCOPE_PURPOSE = "tacho_host_v1" as const;

/**
 * The scope purpose on the second key an enrollment mints: the one the local
 * MCP gateway serves a connected app's tools with (ADR-078). Separate from the
 * host key because the two jobs have different blast radii; `machineKeyDenial`
 * in `@oxagen/iam` is what holds each to its own.
 */
export const TACHO_GATEWAY_SCOPE_PURPOSE = "tacho_gateway_v1" as const;

export const tachoHostApiKeyScopeSchema = z
  .object({
    purpose: z.literal(TACHO_HOST_SCOPE_PURPOSE),
    host_enrollment_id: z.string().regex(/^tch_[a-z0-9]{22}$/),
  })
  .strict();

export type TachoHostApiKeyScope = z.output<typeof tachoHostApiKeyScopeSchema>;

/**
 * Every purpose a Tacho enrolment owns the lifecycle of. Both keys an
 * enrolment mints belong here, and the set is what the generic key
 * capabilities consult.
 */
const RESERVED_TACHO_PURPOSES: ReadonlySet<string> = new Set([
  TACHO_HOST_SCOPE_PURPOSE,
  TACHO_GATEWAY_SCOPE_PURPOSE,
]);

/**
 * Whether this scope names a credential an enrolment owns, so `create_api_key`
 * refuses to mint it and `rotate_api_key` / `revoke_api_key` refuse to touch it.
 *
 * The gateway purpose is in the set for the same reason the host purpose is,
 * and the two failures it prevents are concrete. Rotating the gateway key
 * revokes the old one and hands the replacement to the operator, who has
 * nowhere to put it: the daemon reads that credential from `host.json`, which
 * only an enrolment writes, so the connected app authenticates with a key the
 * control plane has already soft-deleted. Revoking it leaves the host row
 * `active` and its host key live, reporting events, while every connected
 * app's tool call fails auth with nothing on the fleet record saying why.
 * `revoke_tacho_enrollment` and `retire_agent` end both credentials together,
 * and they are the paths the refusal names.
 */
export function requestsReservedTachoPurpose(scope: unknown): boolean {
  if (typeof scope !== "object" || scope === null || !("purpose" in scope)) {
    return false;
  }
  const { purpose } = scope as { purpose?: unknown };
  return typeof purpose === "string" && RESERVED_TACHO_PURPOSES.has(purpose);
}
