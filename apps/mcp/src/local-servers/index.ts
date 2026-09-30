// index.ts: the local-server route and transport bound to Postgres and this
// process's broker (mcp-studio-spec, Local servers; #4773).
import { resolveApiKey } from "@oxagen/auth";
import { schema, withTenantDb } from "@oxagen/database";
import { postgresMachineGroupReader } from "@oxagen/handlers/mcp-studio/local-calls/groups-store";
import { localCallSignerFromEnv } from "@oxagen/handlers/mcp-studio/local-calls/signer";
import { readKeyScope, TACHO_GATEWAY_PURPOSE } from "@oxagen/iam/machine-key-scope";
import type { Transport } from "@oxagen/mcp-studio";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import type { ServedRoute } from "../servers/types";
import { createMachineAuth, type MachineHostRow } from "./auth";
import { localGatewayBroker } from "./broker";
import { createLocalServersRoute } from "./route";
import { localTransport } from "./transport";

/** The host row an enrollment names, read in the key's own workspace. */
async function readMachineHost(
  scope: { orgId: string; workspaceId: string },
  enrollment: string,
): Promise<MachineHostRow | undefined> {
  const hosts = schema.tachoHosts;
  const [row] = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ status: hosts.status, expiresAt: hosts.expiresAt, revokedAt: hosts.revokedAt })
        .from(hosts)
        .where(and(eq(hosts.publicId, enrollment), eq(hosts.orgId, scope.orgId), eq(hosts.workspaceId, scope.workspaceId)))
        .limit(1),
    ),
  );
  return row;
}

/** The machines whose waiting discoveries and listings this process is running now. */
const claiming = new Set<string>();

/**
 * Runs the discoveries (#4772) and the Studio draft listings (ADR-233, #4756)
 * that wait for a machine that polls. One pass per machine at a time: a poll
 * that arrives while the last pass runs adds nothing. The modules load on the
 * first poll, not at boot.
 */
async function claimForPoll(poll: { machine: string; scope: { orgId: string; workspaceId: string } }): Promise<void> {
  if (claiming.has(poll.machine)) return;
  claiming.add(poll.machine);
  try {
    const [{ claimMachineDiscoveries }, { discoverySeams }, { toolsPullRequestOpener }, { claimDraftListings }] =
      await Promise.all([
        import("@oxagen/handlers/mcp-studio/discovery/claim"),
        import("@oxagen/handlers/mcp-studio/discovery/seams"),
        import("@oxagen/handlers/tools.pr.open"),
        import("@oxagen/handlers/mcp-studio/listing/claim"),
      ]);
    await claimMachineDiscoveries(poll, {
      broker: localGatewayBroker(),
      reader: postgresMachineGroupReader,
      // The opener the API installs before each discovery (handlers' register.ts).
      seams: async () => ({ ...(await discoverySeams()), opener: toolsPullRequestOpener }),
    });
    await claimDraftListings(poll, { broker: localGatewayBroker(), reader: postgresMachineGroupReader });
  } finally {
    claiming.delete(poll.machine);
  }
}

type ToolsChange = {
  machine: string;
  scope: { orgId: string; workspaceId: string };
  server: string;
};

/**
 * The servers this process is discovering again after a tools change, keyed
 * by workspace and server, whichever machine reported it. `next` holds a
 * change that arrived during the run, so one more pass follows it.
 */
const rediscovering = new Map<string, { next: ToolsChange | null }>();

/** One discovery of the server, through the machine that reported the change. */
async function rediscoverOnce(change: ToolsChange): Promise<void> {
  const [{ rediscoverOnMachine }, { discoverySeams }, { toolsPullRequestOpener }] = await Promise.all([
    import("@oxagen/handlers/mcp-studio/discovery/claim"),
    import("@oxagen/handlers/mcp-studio/discovery/seams"),
    import("@oxagen/handlers/tools.pr.open"),
  ]);
  await rediscoverOnMachine(change, {
    broker: localGatewayBroker(),
    reader: postgresMachineGroupReader,
    seams: async () => ({ ...(await discoverySeams()), opener: toolsPullRequestOpener }),
  });
}

/**
 * Discovers a server again through the machine whose call reported its tools
 * changed (#4772). One run per workspace and server at a time, so two
 * machines that report the same change do not race for one sync PR. A change
 * reported during a run marks the server, and one more run follows, through
 * the machine that reported last, so the newer tools list is never dropped.
 */
async function rediscoverForChange(change: ToolsChange): Promise<void> {
  const key = `${change.scope.orgId}:${change.scope.workspaceId}:${change.server}`;
  const active = rediscovering.get(key);
  if (active !== undefined) {
    active.next = change;
    return;
  }
  const entry = { next: null as ToolsChange | null };
  rediscovering.set(key, entry);
  try {
    let current: ToolsChange | null = change;
    while (current !== null) {
      entry.next = null;
      await rediscoverOnce(current);
      current = entry.next;
    }
  } finally {
    rediscovering.delete(key);
  }
}

/** Serves GET /v1/local-servers/next and POST /v1/local-servers/replies. */
export const localServersRoute = createLocalServersRoute({
  authenticate: createMachineAuth({
    gatewayPurpose: TACHO_GATEWAY_PURPOSE,
    resolveKey: resolveApiKey,
    readScope: readKeyScope,
    readHost: readMachineHost,
  }),
  broker: localGatewayBroker,
  onPoll: claimForPoll,
  onToolsChanged: rediscoverForChange,
  log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
});

/** The Transport for a served call on the local network, sent through this process's broker. */
export function productionLocalTransport(route: ServedRoute): Transport {
  return localTransport(route, {
    reader: postgresMachineGroupReader,
    signer: () => localCallSignerFromEnv(),
    broker: localGatewayBroker,
  });
}
