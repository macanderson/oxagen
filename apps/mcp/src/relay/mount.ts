// mount.ts: the relay's upgrade mount on the MCP server (lane M12; ADR-225).
//
// A relay connects with an HTTP upgrade to /relay/v1/connect. xmcp 0.6.13
// builds its HTTP server inside its runtime and exports no handle to it and
// no hook that runs when it starts, so this module cannot call
// server.on("upgrade") at startup. Instead it subscribes to Node's
// http.server.request.start diagnostics channel. The first request a server
// answers names that server, and the mount adds the upgrade listener then.
//
// Before that first request, the server has no upgrade listener. Node then
// answers an upgrade as a plain request, so xmcp's routes answer a relay's
// connect with a status other than 101, at once. That request is itself the
// server's first, so the relay's next attempt reaches the broker.
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RelayBroker } from "@oxagen/relay-broker";

/** The channel Node publishes to when an HTTP server starts to answer a request. */
export const REQUEST_START_CHANNEL = "http.server.request.start";

export interface RelayMountLog {
  error(message: string, fields: Record<string, unknown>): void;
}

/**
 * Add the broker's upgrade listener to each HTTP server as it answers its
 * first request. A server that already has an upgrade listener is left
 * alone, because something else owns its upgrades. Returns a function that
 * stops the mount from adding more listeners.
 */
export function mountRelayUpgrades(broker: Pick<RelayBroker, "handleUpgrade">, log: RelayMountLog = console): () => void {
  const seen = new WeakSet<Server>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    broker.handleUpgrade(request, socket, head).catch((error: unknown) => {
      log.error("The relay broker failed on an upgrade, so Oxagen closed the connection.", {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.destroy();
    });
  };

  const onRequestStart = (message: unknown): void => {
    const server = (message as { server?: unknown }).server;
    if (!isServer(server) || seen.has(server)) return;
    seen.add(server);
    if (server.listenerCount("upgrade") > 0) return;
    server.on("upgrade", onUpgrade);
  };

  subscribe(REQUEST_START_CHANNEL, onRequestStart);
  return () => {
    unsubscribe(REQUEST_START_CHANNEL, onRequestStart);
  };
}

function isServer(value: unknown): value is Server {
  return typeof value === "object" && value !== null && typeof (value as Server).listenerCount === "function" && typeof (value as Server).on === "function";
}
