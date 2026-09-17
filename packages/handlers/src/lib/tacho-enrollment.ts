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

export function requestsReservedTachoPurpose(scope: unknown): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === TACHO_HOST_SCOPE_PURPOSE
  );
}
