// broker.ts: builds the MCP server's relay broker from its environment
// (lane M12; ADR-225).
//
// The broker signs each call with TACHO_BUNDLE_SIGNING_PRIVATE_KEY. With no
// key, or a key that does not load, this process builds no broker: it mounts
// no upgrade listener, so no relay connects, and every relay call is refused
// before anything is sent.
import {
  createRelayBroker,
  RELAY_SIGNING_KEY_ENV,
  relaySignerFromEnv,
  type RelayBrokerOptions,
  type RelaySigner,
  type RelayStatusEvent,
  type RelayTokenVerifier,
} from "@oxagen/relay-broker";
import type { RelayBrokerState } from "./transport";

export interface RelayBrokerLog {
  info(message: string, fields: Record<string, unknown>): void;
}

/** One line when a relay gains its first connection or loses its last. No field holds a token. */
export function relayStatusLogger(log: RelayBrokerLog): (event: RelayStatusEvent) => void {
  return (event) => {
    log.info(`Relay ${event.relay} is ${event.status}: ${event.reason}.`, {
      orgId: event.orgId,
      workspaceId: event.workspaceId,
      relay: event.relay,
      status: event.status,
    });
  };
}

/** The broker for this environment, or the reason a relay call is refused. */
export function buildRelayBroker(
  env: Readonly<Record<string, string | undefined>>,
  verifier: RelayTokenVerifier,
  options: Omit<RelayBrokerOptions, "verifier" | "signer"> = {},
): RelayBrokerState {
  let signer: RelaySigner | undefined;
  try {
    signer = relaySignerFromEnv(env);
  } catch (error) {
    return {
      broker: null,
      reason: `This deployment's relay signing key does not load, so Oxagen sent nothing: ${error instanceof Error ? error.message : String(error)} Ask an Oxagen operator to fix ${RELAY_SIGNING_KEY_ENV} on the MCP service.`,
    };
  }
  if (signer === undefined) {
    return {
      broker: null,
      reason: `This deployment holds no key to sign relay calls, so Oxagen sent nothing. Ask an Oxagen operator to set ${RELAY_SIGNING_KEY_ENV} on the MCP service.`,
    };
  }
  return { broker: createRelayBroker({ ...options, verifier, signer }) };
}
