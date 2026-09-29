// meter.ts: the governed action one served call, search, or describe
// records (lane M15; mcp-studio-spec, Spend).
//
// Every call is one governed action whether policy allows it, denies it, or
// parks it. The ledger key is the id Oxagen makes for each action. The
// ledger drops a second entry with the same key, so a key the client chose,
// such as its x-request-id, would let it repeat one id and pay for one call.
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
 *
 * The run is the tacho session the request names (its tse_ id), the id the
 * approval for the same call records. A request that names no session
 * records no run. Tacho ingest records the root session's id for a hook
 * reported call, so a served call from a child session carries the child's id.
 */
export function meterEntry(event: MeterEvent): GovernedActionEntry {
  const { run } = event;
  const scope = run.sessionId ?? run.workspaceId;
  return {
    idempotencyKey: `external_tool:${scope}:mcp:${event.id}`,
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
    runId: run.sessionId === null ? null : run.runPublicId,
    sessionId: run.sessionId,
    toolCallId: null,
    requestId: run.requestId,
    units: 1,
    occurredAt: event.at,
  };
}
