import { randomUUID } from "node:crypto";
import {
  insertToolInvocation,
  type ToolInvocationRow,
} from "@oxagen/telemetry";
import { logger } from "./logger";

/**
 * Minimal slice of CapabilityContext needed to attribute a graph telemetry
 * row. Kept local so both destructive graph handlers share one emit path.
 */
export interface GraphTelemetryContext {
  orgId: string;
  workspaceId: string;
  surface: ToolInvocationRow["surface"];
  messageId: string | null;
}

export interface GraphDeletionTelemetry {
  capability: string;
  latencyMs: number;
  succeeded: boolean;
}

/**
 * Emit a ToolInvocationRow for a destructive graph op (node/edge delete).
 * Reuses the shared @oxagen/telemetry seam — never a direct ClickHouse SDK
 * call (policy §9). Best-effort and fire-and-forget: a telemetry failure is
 * logged and swallowed so it never delays or fails the capability response.
 */
export function emitGraphDeletionTelemetry(
  ctx: GraphTelemetryContext,
  { capability, latencyMs, succeeded }: GraphDeletionTelemetry,
): void {
  const row: ToolInvocationRow = {
    invocation_id: randomUUID(),
    org_id: ctx.orgId,
    workspace_id: ctx.workspaceId,
    capability_name: capability,
    message_id: ctx.messageId ?? "",
    parent_message_id: null,
    execution_step_id: null,
    status: succeeded ? "completed" : "failed",
    input_size_bytes: 0,
    output_size_bytes: 0,
    latency_ms: latencyMs,
    error_class: null,
    external_provider: "",
    external_server_id: null,
    risk_level: "high",
    required_approval: 0,
    surface: ctx.surface,
    provider: "",
    created_at: new Date().toISOString(),
  };
  void insertToolInvocation(row).catch((err: unknown) => {
    logger.warn(
      { capability, err },
      "graph delete: telemetry insert failed (non-fatal)",
    );
  });
}
