// mount.test.ts: the relay's upgrade mount on the MCP server (lane M12).
//
// Each test runs a real HTTP server on 127.0.0.1 with a fake broker, because
// the mount's behavior depends on how Node's HTTP server treats an upgrade
// with and without an upgrade listener.
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountRelayUpgrades } from "./mount";

const CONNECT_PATH = "/relay/v1/connect";
/** A request that takes longer than this hangs, which the mount must never allow. */
const ANSWER_WITHIN_MS = 2_000;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A server that answers every plain request with 426, the way a route with no upgrade support might. */
async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.statusCode = 426;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { server, port: (server.address() as AddressInfo).port };
}

function mount(broker: { handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> }, log = { error: vi.fn() }) {
  const stop = mountRelayUpgrades(broker, log);
  cleanups.push(stop);
  return { stop, log };
}

/** A broker that answers every upgrade with 401 and closes the socket. */
function refusingBroker() {
  return {
    handleUpgrade: vi.fn(async (_request: IncomingMessage, socket: Duplex) => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }),
  };
}

type Answer = { kind: "response"; status: number | undefined } | { kind: "upgrade"; status: number | undefined };

/** Send one request and resolve with the server's answer. Rejects when the server hangs or drops the socket. */
function send(port: number, options: { path?: string; upgrade?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = options.upgrade === false ? {} : { Connection: "Upgrade", Upgrade: "websocket" };
    const outgoing = request({ host: "127.0.0.1", port, path: options.path ?? CONNECT_PATH, agent: false, headers });
    outgoing.setTimeout(ANSWER_WITHIN_MS, () => outgoing.destroy(new Error(`The server did not answer within ${ANSWER_WITHIN_MS} ms.`)));
    outgoing.on("response", (response) => {
      response.resume();
      resolve({ kind: "response", status: response.statusCode });
    });
    outgoing.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ kind: "upgrade", status: response.statusCode });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("mountRelayUpgrades", () => {
  it("answers an upgrade that arrives before any request at once, and sends the next one to the broker", async () => {
    const { port } = await startServer();
    const broker = refusingBroker();
    mount(broker);

    // The server has no upgrade listener yet, so Node answers the upgrade as
    // a plain request. The route answers at once, and the request names the
    // server to the mount.
    await expect(send(port)).resolves.toEqual({ kind: "response", status: 426 });
    expect(broker.handleUpgrade).not.toHaveBeenCalled();

    await expect(send(port)).resolves.toEqual({ kind: "response", status: 401 });
    expect(broker.handleUpgrade).toHaveBeenCalledTimes(1);
  });

  it("sends an upgrade to the broker after the server's first plain request", async () => {
    const { server, port } = await startServer();
    const broker = refusingBroker();
    mount(broker);

    await expect(send(port, { path: "/healthz", upgrade: false })).resolves.toEqual({ kind: "response", status: 426 });
    expect(server.listenerCount("upgrade")).toBe(1);

    await expect(send(port)).resolves.toEqual({ kind: "response", status: 401 });
    const [incoming] = broker.handleUpgrade.mock.calls[0] ?? [];
    expect(incoming?.url).toBe(CONNECT_PATH);
  });

  it("adds one upgrade listener to a server, however many requests it answers", async () => {
    const { server, port } = await startServer();
    mount(refusingBroker());

    for (let index = 0; index < 3; index += 1) await send(port, { upgrade: false });
    expect(server.listenerCount("upgrade")).toBe(1);
  });

  it("leaves a server alone when something else already takes its upgrades", async () => {
    const { server, port } = await startServer();
    const owner = vi.fn((_request: IncomingMessage, socket: Duplex) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    server.on("upgrade", owner);
    const broker = refusingBroker();
    mount(broker);

    await send(port, { upgrade: false });
    await expect(send(port)).resolves.toEqual({ kind: "response", status: 403 });
    expect(owner).toHaveBeenCalledTimes(1);
    expect(broker.handleUpgrade).not.toHaveBeenCalled();
    expect(server.listenerCount("upgrade")).toBe(1);
  });

  it("closes the connection and logs one error when the broker fails on an upgrade", async () => {
    const { port } = await startServer();
    const broker = { handleUpgrade: vi.fn(async () => Promise.reject(new Error("verifier crashed"))) };
    const { log } = mount(broker);

    await send(port, { upgrade: false });
    await expect(send(port)).rejects.toThrow();
    expect(broker.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("closed the connection"), { error: "verifier crashed" });
  });

  it("adds no listener to a server that answers its first request after the mount stops", async () => {
    const { server, port } = await startServer();
    const { stop } = mount(refusingBroker());
    stop();

    await send(port, { upgrade: false });
    expect(server.listenerCount("upgrade")).toBe(0);
  });
});
