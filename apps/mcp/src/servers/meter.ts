// meter.ts: the governed action one served call, search, or describe
// records (lane M15; mcp-studio-spec, Spend).
//
// Every call is one governed action whether policy allows it, denies it, or
// parks it. The ledger key is the HTTP request's id, so a request the agent
// sends again is a second action.
import type { GovernedActionEntry } from "@oxagen/billing";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import type { MeterEvent } from "./types";

/** The label recordGovernedActions logs the batch under. */
export const METER_LABEL = "mcp:served_tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ledger entry for one governed action. It mirrors governedActionEntry,
 * ledgerKey, and attributableWorkspaceId, which this file cannot import at
 * run time without the billing runtime.
 */
export function meterEntry(event: MeterEvent): GovernedActionEntry {
  const { run } = event;
  const scope = run.sessionId ?? run.workspaceId;
  return {
    idempotencyKey: `external_tool:${scope}:mcp:${run.requestId}`,
    source: "external_tool",
    capability: null,
    toolName: event.tool,
    mcpServer: event.server,
    surface: "mcp",
    harness: run.harness,
    workspaceId: UUID.test(run.workspaceId) && run.workspaceId !== ORG_ONLY_WORKSPACE_ID ? run.workspaceId : null,
    agentId: event.agent,
    principalId: null,
    principalKind: null,
    operatorUserId: null,
    runId: null,
    sessionId: run.sessionId,
    toolCallId: null,
    requestId: run.requestId,
    units: 1,
    occurredAt: event.at,
  };
}
