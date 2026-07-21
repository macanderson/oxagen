import type { CapabilityHandler } from "@oxagen/oxagen";
import { telemetryStellaIngest } from "@oxagen/oxagen/contracts/telemetry.stella.ingest";
import { insertStellaOperationalEvents } from "@oxagen/telemetry";
import { logger } from "./logger";

export const telemetryStellaIngestHandler: CapabilityHandler<
  typeof telemetryStellaIngest
> = async (input, ctx) => {
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
