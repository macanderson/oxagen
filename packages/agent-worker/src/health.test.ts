/**
 * Coverage for the worker's liveness listener.
 *
 * The point of this file is the drain contract: the node's deploy poll reads
 * `health_path` for up to a minute after start, and a worker that answers 200
 * while it is draining hands the next deploy a false green. So both sides of
 * `HealthState.draining` are pinned here against a real socket — the mutation
 * is read per request, not captured at listen time, which is the property a
 * mocked `createServer` could not show.
 *
 * A real listener on port 0 (the OS picks a free one) rather than a fake:
 * this module's whole job is the wire behaviour — status code, content type,
 * body shape, and the 404 for anything else — and a stub of `node:http` would
 * assert the stub.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startHealthServer, type HealthState } from "./health";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** Start on an ephemeral port and resolve once the socket is accepting. */
async function listen(
  state: HealthState,
): Promise<{ server: Server; url: string }> {
  const server = startHealthServer(0, state);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { address, port } = server.address() as AddressInfo;
  return { server, url: `http://${address}:${port}` };
}

describe("startHealthServer", () => {
  it("binds loopback only — Caddy has no route to the worker", async () => {
    const { server } = await listen({ draining: false });
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("answers /healthz with 200 and an ok body while serving", async () => {
    const { url } = await listen({ draining: false });

    const res = await fetch(`${url}/healthz`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as {
      ok: boolean;
      startedAt: string;
      pid: number;
    };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
  });

  it("serves the same payload at / — the node polls either", async () => {
    const { url } = await listen({ draining: false });

    const res = await fetch(`${url}/`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("reports 503 once SIGTERM flips draining, without closing the socket", async () => {
    // The state object is what main.ts mutates in `shutdown`; the listener has
    // to read it per request or a draining worker keeps answering 200.
    const state: HealthState = { draining: false };
    const { url } = await listen(state);

    expect((await fetch(`${url}/healthz`)).status).toBe(200);

    state.draining = true;

    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("holds startedAt fixed across requests", async () => {
    const { url } = await listen({ draining: false });

    const first = (await (await fetch(`${url}/healthz`)).json()) as {
      startedAt: string;
    };
    const second = (await (await fetch(`${url}/healthz`)).json()) as {
      startedAt: string;
    };

    expect(second.startedAt).toBe(first.startedAt);
  });

  it("404s any other path — one route, no accidental surface", async () => {
    const { url } = await listen({ draining: false });

    const res = await fetch(`${url}/metrics`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});
