/** The servers the drain closes on the first SIGTERM or SIGINT (#5318). */
export declare function installDrain(options?: {
  net?: { Server: { prototype: { listen: (...args: unknown[]) => unknown } } };
  signals?: { once(signal: "SIGTERM" | "SIGINT", listener: (signal: string) => void): unknown };
  exit?: (code: number) => void;
  log?: (message: string) => void;
}): { servers: Set<{ close(callback?: (error?: Error) => void): unknown; closeIdleConnections?: () => void }> };
