// transport.ts: the Transport for a served call on the local network
// (mcp-studio-spec, Call path and Local servers; #4773).
//
// It signs the call and hands it to the broker, where the machine's
// long-poll picks it up. When a call cannot be signed or routed, it raises a
// ServedRouteError that says what to fix, and nothing is sent.
import { TACHO_BUNDLE_SIGNING_KEY_ENV } from "@oxagen/handlers/lib/tacho-bundle-signing";
import type { LocalGatewayBroker } from "@oxagen/handlers/mcp-studio/local-calls/broker";
import { launchSpecFor, machineGroupsOf } from "@oxagen/handlers/mcp-studio/local-calls/launch";
import type { MachineGroupReader } from "@oxagen/handlers/mcp-studio/local-calls/machines";
import type { LocalCallSigner } from "@oxagen/handlers/mcp-studio/local-calls/signer";
import { createLocalTransport } from "@oxagen/handlers/mcp-studio/local-calls/transport";
import type { Transport } from "@oxagen/mcp-studio";
import { ServedRouteError, type ServedRoute } from "../servers/types";

export interface LocalTransportDeps {
  reader: MachineGroupReader;
  /** The key local calls are signed with, or undefined when this deployment holds none. */
  signer(): LocalCallSigner | undefined;
  broker(): LocalGatewayBroker;
}

/** The Transport for one call to a local server on the run's machine. */
export function localTransport(route: ServedRoute, deps: LocalTransportDeps): Transport {
  const { server, run } = route;
  const signer = deps.signer();
  if (signer === undefined) {
    throw new ServedRouteError(
      "local_unavailable",
      `This deployment holds no key to sign local calls, so Oxagen sent nothing. Ask an Oxagen operator to set ${TACHO_BUNDLE_SIGNING_KEY_ENV}.`,
    );
  }
  if (run.machine === null) {
    throw new ServedRouteError(
      "local_unavailable",
      "This run names no enrolled machine, so Oxagen sent nothing. Run the agent under tacho on an enrolled machine, then retry.",
    );
  }
  const { pinned } = server;
  const launch =
    pinned.type === "local" || pinned.type === "registry" ? launchSpecFor(server.name, pinned, server.source) : undefined;
  if (launch === undefined) {
    throw new ServedRouteError(
      "local_unavailable",
      `The lock does not say how a machine starts ${server.name}, so Oxagen sent nothing. Run tools lock in the steering repo, then open a steering PR.`,
    );
  }
  return createLocalTransport({
    scope: { orgId: run.orgId, workspaceId: run.workspaceId },
    machine: run.machine,
    groups: machineGroupsOf(server.source),
    reader: deps.reader,
    signer,
    broker: deps.broker(),
    launch,
  });
}
