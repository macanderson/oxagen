// How the long-running API process stops when a deploy replaces it (#5318).
//
// infra/tools/node/deploy-service.sh sends SIGTERM to the current container
// and starts the new release on the same port once this process lets go of
// it. Without a handler, node runs as PID 1 and ignores SIGTERM, so the deploy
// waited 10 seconds and sent SIGKILL, cutting off every request in progress.
//
// On SIGTERM or SIGINT the server closes its listener at once, which frees
// the port, and closes its idle keep-alive connections, so Caddy dials the new
// release for its next request. The requests already accepted finish, and the
// process exits when the last connection closes. The deploy removes the
// container after its drain window whether or not that has happened.

/** The part of a Node HTTP server the drain uses. */
export type DrainableServer = {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
};

/** The part of the API's logger the drain uses. */
export type DrainLog = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

/** Where the drain listens for a stop signal. `process` in production. */
export type SignalSource = {
  once(signal: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
};

/**
 * Close the server's port on the first SIGTERM or SIGINT, let the requests in
 * progress finish, then exit: 0 on a clean close, 1 when the close fails.
 */
export function drainOnSignal(
  server: DrainableServer,
  log: DrainLog,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: SignalSource = process,
): void {
  let draining = false;
  const drain = (signal: NodeJS.Signals): void => {
    if (draining) return;
    draining = true;
    log.info({ signal }, "api closing its port and finishing the requests in progress");
    server.close((error) => {
      if (error) log.error({ err: error }, "api closed with an error");
      exit(error ? 1 : 0);
    });
    server.closeIdleConnections?.();
  };
  signals.once("SIGTERM", drain);
  signals.once("SIGINT", drain);
}
