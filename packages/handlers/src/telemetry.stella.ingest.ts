import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { telemetryStellaIngest } from "@oxagen/oxagen/contracts/telemetry.stella.ingest";
import { resolveOrgTier, isTierDenied, requireTier } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { insertStellaOperationalEvents } from "@oxagen/telemetry";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { stellaOperationalTelemetryApiKeyScopeSchema } from "./lib/stella-telemetry-enrollment";
import { logger } from "./logger";

function enrollmentDenied(message: string): CapabilityError {
  return new CapabilityError(
    telemetryStellaIngest.name,
    "authz_denied",
    message,
  );
}

export const telemetryStellaIngestHandler: CapabilityHandler<
  typeof telemetryStellaIngest
> = async (input, ctx) => {
  if (!ctx.apiKeyId) {
    throw enrollmentDenied("Forbidden: enrolled Stella API key required");
  }
  const apiKeyId = ctx.apiKeyId;

  const tier = await resolveOrgTier(ctx.orgId);
  try {
    requireTier(tier, "enterprise", "stella-operational-telemetry");
  } catch (err) {
    if (!isTierDenied(err)) throw err;
    throw enrollmentDenied("Forbidden: Enterprise plan required");
  }

  const apiKey = await withTenantDb((tx) =>
    tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.id, apiKeyId),
        isNull(schema.apiKeys.deletedAt),
        or(
          isNull(schema.apiKeys.expiresAt),
          gt(schema.apiKeys.expiresAt, new Date()),
        ),
      ),
      columns: { scope: true },
    }),
  );
  const protectedScope = stellaOperationalTelemetryApiKeyScopeSchema.safeParse(
    apiKey?.scope,
  );
  if (!protectedScope.success) {
    throw enrollmentDenied("Forbidden: enrolled Stella API-key scope required");
  }
  if (
    input.events.some(
      (event) => event.enrollment_id !== protectedScope.data.enrollment_id,
    )
  ) {
    throw enrollmentDenied("Forbidden: Stella enrollment mismatch");
  }

  const rows = input.events.map((event) => ({
    schema: event.schema,
    event_class: event.event_class,
    event_id: event.event_id,
    enrollment_id: event.enrollment_id,
    provider: event.provider,
    model: event.model,
    outcome: event.outcome,
    duration_ms: event.duration_ms,
    input_tokens: event.input_tokens,
    output_tokens: event.output_tokens,
    cost_microusd: event.cost_microusd,
    tool_call_count: event.tool_call_count,
    changed_file_count: event.changed_file_count,
    produced_output: event.produced_output,
  }));

  try {
    await insertStellaOperationalEvents(rows);
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        accepted: rows.length,
      },
      "telemetry.stella.ingest: append failed",
    );
    throw err;
  }

  return {
    accepted: rows.length,
    event_ids: rows.map((row) => row.event_id),
  };
};
