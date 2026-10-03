// How the MCP server stops when a deploy replaces it (#5318).
//
// infra/tools/node/deploy-service.sh sends SIGTERM to the current container
// and starts the new release on the same port once this process lets go of
// it. xmcp builds the HTTP server in dist/http.js and handles no signal, so
// node, running as PID 1, ignored SIGTERM and the deploy sent SIGKILL after
// 10 seconds, cutting off every request in progress.
//
// drain-preload.cjs loads this module with `node --require` before
// dist/http.js. It records every server that starts listening, and on the
// first SIGTERM or SIGINT it closes each one's port and idle keep-alive
// connections, lets the requests in progress finish, and exits once every
// server has closed: 0 on a clean close, 1 when a close fails.
"use strict";

/**
 * @param {{
 *   net?: { Server: { prototype: { listen: (...args: unknown[]) => unknown } } },
 *   signals?: { once(signal: "SIGTERM" | "SIGINT", listener: (signal: string) => void): unknown },
 *   exit?: (code: number) => void,
 *   log?: (message: string) => void,
 * }} [options]
 */
function installDrain(options = {}) {
  const net = options.net ?? require("node:net");
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code) => process.exit(code));
  const log = options.log ?? ((message) => console.log(message));

  const servers = new Set();
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function recordListen(...args) {
    servers.add(this);
    return listen.apply(this, args);
  };

  let draining = false;
  const drain = (signal) => {
    if (draining) return;
    draining = true;
    log(`mcp: ${signal}: closing ${servers.size} port(s) and finishing the requests in progress`);
    if (servers.size === 0) {
      exit(0);
      return;
    }
    let open = servers.size;
    let failed = false;
    for (const server of servers) {
      server.close((error) => {
        if (error) {
          failed = true;
          log(`mcp: a server closed with an error: ${error.message}`);
        }
        open -= 1;
        if (open === 0) exit(failed ? 1 : 0);
      });
      server.closeIdleConnections?.();
    }
  };
  signals.once("SIGTERM", drain);
  signals.once("SIGINT", drain);
  return { servers };
}

module.exports = { installDrain };
