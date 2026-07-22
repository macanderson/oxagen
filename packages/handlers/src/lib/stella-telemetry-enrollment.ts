import { z } from "zod";

export const STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE =
  "stella_operational_telemetry_v1" as const;

const ENROLLMENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export const stellaOperationalTelemetryApiKeyScopeSchema = z
  .object({
    purpose: z.literal(STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE),
    enrollment_id: z.string().min(1).max(128).regex(ENROLLMENT_ID_PATTERN),
  })
  .strict();

export function requestsReservedStellaTelemetryPurpose(
  scope: unknown,
): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === STELLA_OPERATIONAL_TELEMETRY_SCOPE_PURPOSE
  );
}
