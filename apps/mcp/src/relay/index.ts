// index.ts: the MCP server's relay, wired to production (lane M12; ADR-225).
//
// One broker serves the whole process. It holds every relay's connection, so
// the connect and the calls that use it must reach the same process. The
// MCP service runs as one container on one shared node (infra/tools/node),
// which is why one broker per process is enough today. A second process
// would need a shared broker before it could carry relay calls.
import { schema, withTenantDb } from "@oxagen/database";
import { postgresRelayTokenVerifier } from "@oxagen/handlers/mcp-studio/relays/verifier";
import type { RelayScope } from "@oxagen/relay-broker";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { buildRelayBroker, relayStatusLogger } from "./broker";
import { mountRelayUpgrades } from "./mount";
import { createRelayTransport, type RelayBrokerState, type RelayRoute, type RelayTransport } from "./transport";

let state: RelayBrokerState | undefined;
let mounted = false;

/** The process's broker, built on first use. */
export function relayBrokerState(): RelayBrokerState {
  state ??= buildRelayBroker(process.env, postgresRelayTokenVerifier, { onStatus: relayStatusLogger(console) });
  return state;
}

/**
 * The run names a workspace with no row. The relay Transport logs only an
 * error's name, so this name tells that case apart from a failed read.
 */
class RelayWorkspaceMissingError extends Error {
  override readonly name = "RelayWorkspaceMissingError";
}

/** The workspace's public id, which each envelope names and the relay checks. */
async function readRelayScope(orgId: string, workspaceId: string): Promise<RelayScope> {
  const scope = { orgId, workspaceId };
  const [row] = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ publicId: schema.workspaces.publicId })
        .from(schema.workspaces)
        .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)))
        .limit(1),
    ),
  );
  if (row === undefined) throw new RelayWorkspaceMissingError("The run's workspace does not exist.");
  return { orgId, workspaceId, workspacePublicId: row.publicId };
}

/** The Transport for one call on a relay:<name> network. */
export function relayTransport(route: RelayRoute): RelayTransport {
  return createRelayTransport(route, {
    broker: relayBrokerState,
    scope: readRelayScope,
    warn: (message, fields) => console.warn(message, fields),
  });
}

/**
 * Start taking relay connections on the MCP server. With no signing key it
 * logs one warning and mounts nothing, so a relay's connect gets the
 * server's ordinary answer and the relay keeps retrying.
 */
export function installRelayMount(): void {
  if (mounted) return;
  mounted = true;
  const current = relayBrokerState();
  if (current.broker === null) {
    console.warn(`The MCP server takes no relay connections. ${current.reason}`);
    return;
  }
  mountRelayUpgrades(current.broker);
}
