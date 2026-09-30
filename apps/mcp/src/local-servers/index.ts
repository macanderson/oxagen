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

/** Serves GET /v1/local-servers/next and POST /v1/local-servers/replies. */
export const localServersRoute = createLocalServersRoute({
  authenticate: createMachineAuth({
    gatewayPurpose: TACHO_GATEWAY_PURPOSE,
    resolveKey: resolveApiKey,
    readScope: readKeyScope,
    readHost: readMachineHost,
  }),
  broker: localGatewayBroker,
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
