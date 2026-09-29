// transport.ts: the Transport a served call on a relay:<name> network uses
// (lane M12; mcp-studio-spec, Network paths).
//
// transportFor in servers/ports.ts must answer at once, but the broker's
// scope needs the workspace's public id, which only the database holds. So
// this Transport reads the scope on its first call and then hands each call
// to the process's broker. Every refusal is a TransportError, which the
// executor turns into the call's answer, so nothing here throws past it.
import type { RelayBroker, RelayScope } from "@oxagen/relay-broker";
import { TransportError, type Transport } from "@oxagen/mcp-studio";

/** The process's broker, or why this deployment has none. */
export type RelayBrokerState = { broker: RelayBroker } | { broker: null; reason: string };

export interface RelayTransportDeps {
  broker(): RelayBrokerState;
  /** The broker's scope for the run's organization and workspace. */
  scope(orgId: string, workspaceId: string): Promise<RelayScope>;
}

/** A Transport for one run's calls on relay networks. */
export function createRelayTransport(run: { orgId: string; workspaceId: string }, deps: RelayTransportDeps): Transport {
  let scope: Promise<RelayScope> | undefined;

  function readScope(): Promise<RelayScope> {
    scope ??= deps.scope(run.orgId, run.workspaceId).catch((error: unknown) => {
      // A failed read is not kept, so the run's next call reads again.
      scope = undefined;
      throw new TransportError(
        "not_sent",
        `Oxagen could not read the workspace for this relay call, so it sent nothing: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    });
    return scope;
  }

  async function brokerTransport(): Promise<Transport> {
    const state = deps.broker();
    if (state.broker === null) throw new TransportError("unsupported", state.reason, false);
    return state.broker.transport(await readScope());
  }

  return {
    http: async (request) => (await brokerTransport()).http(request),
    grpc: async (request) => (await brokerTransport()).grpc(request),
    local: () => Promise.reject(new TransportError("unsupported", "A relay does not carry local server calls.", false)),
  };
}
