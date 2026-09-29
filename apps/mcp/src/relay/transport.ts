// transport.ts: the Transport a served call on a relay:<name> network uses
// (lane M12; mcp-studio-spec, Network paths).
//
// transportFor in servers/ports.ts must answer at once, but the broker's
// scope needs the workspace's public id, which only the database holds. So
// this Transport reads the scope on its first use and then hands each call
// to the process's broker. Every refusal is a TransportError, which the
// executor turns into the call's answer, so nothing here throws past it.
import type { RelayBroker, RelayScope } from "@oxagen/relay-broker";
import { TransportError, type ResolvedCredential, type Transport } from "@oxagen/mcp-studio";

/** The process's broker, or why this deployment has none. */
export type RelayBrokerState = { broker: RelayBroker } | { broker: null; reason: string };

export interface RelayTransportDeps {
  broker(): RelayBrokerState;
  /** The broker's scope for the run's organization and workspace. */
  scope(orgId: string, workspaceId: string): Promise<RelayScope>;
  /** Where a failed scope read is logged. It gets the error's name, never its message. */
  warn?(message: string, fields: Record<string, unknown>): void;
}

/** One call's route: the relay:<name> network and the run it acts for. */
export interface RelayRoute {
  network: string;
  run: { orgId: string; workspaceId: string };
}

/** A relay Transport that can say, before any send, why the broker would refuse a call. */
export interface RelayTransport extends Transport {
  /**
   * Why the broker would refuse this route's call before sending it, or null
   * when it would take the call. It sends nothing. The relay can still
   * disconnect between this check and the send, and a body over the
   * broker's size limit is refused only at the send.
   */
  refusal(credential: ResolvedCredential | null): Promise<string | null>;
}

const SCOPE_READ_FAILED =
  "Oxagen could not read the workspace for this relay call, so it sent nothing. Call the tool again in a minute.";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A Transport for one call's route on a relay network. */
export function createRelayTransport(route: RelayRoute, deps: RelayTransportDeps): RelayTransport {
  let scope: Promise<RelayScope> | undefined;

  function readScope(): Promise<RelayScope> {
    scope ??= deps.scope(route.run.orgId, route.run.workspaceId).catch((error: unknown) => {
      // A failed read is not kept, so the next use reads again.
      scope = undefined;
      // The failure's own message can quote a query or a connection string,
      // and the refusal reaches the agent, so both name only what failed.
      deps.warn?.("The relay call's workspace read failed, so the call was not sent.", { error: errorName(error) });
      throw new TransportError("not_sent", SCOPE_READ_FAILED, false);
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
    async refusal(credential) {
      const state = deps.broker();
      if (state.broker === null) return state.reason;
      try {
        await state.broker.ready(
          await readScope(),
          route.network,
          credential?.type === "relay" ? credential.credential : undefined,
        );
        return null;
      } catch (error) {
        if (error instanceof TransportError) return error.message;
        throw error;
      }
    },
  };
}
