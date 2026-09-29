// kill-switch.ts: the emergency denies a served tool call answers to (#4666).
//
// A served call runs through the same kill switch gate as a tool the in-app
// agent materializes (packages/agent/src/runtime/kill-switch-gate.ts). The
// gate reads the switches and matches them. This file only names the call's
// facts in the gate's terms:
//
// - The capability id is the registry's: mcp.<server id>.<full tool name>.
//   The steering projection writes each served tool as an agent.tools row
//   with that name and the server's mcp.mcp_servers id, so a tool_version
//   switch and a class switch reach it.
// - The server is the mcp.mcp_servers row whose steering_name is the
//   manifest's server name, so a tool_server switch reaches it.
// - The connection is the mcp.mcp_credentials row the environment's
//   credential reference names, so a connection switch reaches a call that
//   signs in with it. An operator's own OAuth token is not a connection, so
//   no connection switch reaches an operator-mode call.
// - The operator is the person who enrolled the host, so an operator switch
//   on them stops every session the host opens.
//
// A served agent is a steering agent file, not an agents row, so it has no
// agt_ id and an agent switch does not reach it. The org and workspace
// switches reach every call.
import { createKillSwitchGate, type KillSwitchGateReads } from "@oxagen/agent/runtime/kill-switch-gate";
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";
import type { EmergencyCall, EmergencyDeny, ServedRun } from "./types";

/** The registry rows a call's server and credential name. Null when no row matches. */
export interface SwitchTargets {
  serverId: string | null;
  connectionId: string | null;
}

/** The reads one run's check makes. The tests pass fakes. */
export interface EmergencyDenyReads {
  gate: KillSwitchGateReads;
  targets(run: ServedRun, call: { server: string; credential: string | null }): Promise<SwitchTargets>;
}

/**
 * The emergency deny check for one run. The gate reads the switches on the
 * first call and keeps them. A call that writes re-reads the deny generation
 * first, so a switch turned on between two calls stops the second.
 */
export function servedEmergencyDenies(
  run: ServedRun,
  reads: EmergencyDenyReads,
): (call: EmergencyCall) => Promise<EmergencyDeny | null> {
  const gate = createKillSwitchGate(
    {
      orgId: run.orgId,
      workspaceId: run.workspaceId,
      userId: run.operator ?? null,
      apiKeyId: null,
      requestId: run.requestId,
      surface: "mcp",
      messageId: null,
    },
    reads.gate,
  );
  return async (call) => {
    const { serverId, connectionId } = await reads.targets(run, { server: call.server, credential: call.credential });
    const hit = await gate.check({
      capabilityId: registryCapabilityId({ source: "mcp", slug: call.tool, name: call.tool, mcpServerId: serverId }),
      serverId,
      connectionId,
      readOnly: call.readOnly,
    });
    return hit === null ? null : { id: hit.publicId, targetKind: hit.targetKind, targetId: hit.targetId, reason: hit.reason };
  };
}
