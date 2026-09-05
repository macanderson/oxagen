import { randomUUID } from "node:crypto";
import {
  insertToolInvocation,
  type ToolInvocationRow,
} from "@oxagen/telemetry";
import { logger } from "./logger";

/**
 * Minimal slice of CapabilityContext needed to attribute a graph telemetry
 * row. Kept local so both destructive graph handlers share one emit path.
 *
 * `executionStepId` mirrors `CapabilityContext.executionStepId` (#2597):
 * present only when this delete happened inside a run, absent for a direct
 * API/MCP/human call. Absent means absent — never substitute `messageId` or a
 * fresh id here, the same rule #2616 established for `CapabilityContext`.
 */
export interface GraphTelemetryContext {
  orgId: string;
  workspaceId: string;
  surface: ToolInvocationRow["surface"];
  messageId: string | null;
  executionStepId?: string | null;
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
 *
 * Currently unwired: the client-authored graph-mutation capability this
 * existed for was retired (`20260804110000_retire_client_graph_mutation.sql`)
 * and nothing calls this function today — see #1380, which tracks whether it
 * should be deleted or kept for a future graph-mutation surface. Fixed here
 * for #2615 regardless, so the row shape is correct the moment either a
 * caller returns or #1380 is resolved the other way.
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
    execution_step_id: ctx.executionStepId ?? null,
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
