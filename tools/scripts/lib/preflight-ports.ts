import net from "node:net";

export interface AppPort {
  port: number;
  name: string;
}

// The four long-running app servers `pnpm dev` launches via turbo. The Docker
// datastore ports (5433/8123/7687) are intentionally excluded: `docker compose
// up -d` is idempotent, so an already-running datastore is never a conflict —
// only an already-bound APP port makes turbo crash with EADDRINUSE.
export const APP_PORTS: readonly AppPort[] = [
  { port: 3000, name: "app" },
  { port: 3300, name: "docs" },
  { port: 4000, name: "api" },
  { port: 4100, name: "mcp" },
];

// True if something is already listening on `port` on the loopback interface.
// A successful TCP connect means a server holds the port; a refused connection
// or timeout means it's free. Read-only — never binds or sends data.
export function isPortInUse(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (inUse: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export type StackPreflight =
  | { status: "clean" }
  | { status: "running"; bound: AppPort[] }
  | { status: "partial"; bound: AppPort[]; free: AppPort[] };

// Pure classifier: given which app ports are already bound, decide whether the
// stack is not running (clean — safe to launch), fully running (reuse it, do not
// double-boot), or partially up (wedged — needs a clean restart). Kept pure so
// the launch decision is unit-testable without real sockets.
export function classifyStack(
  bound: AppPort[],
  ports: readonly AppPort[] = APP_PORTS,
): StackPreflight {
  if (bound.length === 0) return { status: "clean" };
  if (bound.length >= ports.length) return { status: "running", bound };
  const boundPorts = new Set(bound.map((b) => b.port));
  return {
    status: "partial",
    bound,
    free: ports.filter((p) => !boundPorts.has(p.port)),
  };
}

// Probe every app port and classify the result. Separated from the logging/exit
// side effects in dev.ts so it can be exercised directly.
export async function inspectAppPorts(
  ports: readonly AppPort[] = APP_PORTS,
): Promise<StackPreflight> {
  const bound: AppPort[] = [];
  for (const p of ports) {
    if (await isPortInUse(p.port)) bound.push(p);
  }
  return classifyStack(bound, ports);
}
