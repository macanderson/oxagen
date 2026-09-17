/**
 * The listener as a listener: a real TCP server, real sockets, real headers.
 * The pure predicates are covered in `loopback-guard.test.ts` and the proxy in
 * `mcp-gateway.test.ts`; what this file proves is that they are actually
 * wired into the server a browser could reach, and that the Unix socket —
 * which no browser can address — is not made unusable by the guard meant for
 * the TCP one.
 */
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CollectorApi,
  type CollectorServer,
  createCollectorServer,
} from "./server";

const TOKEN = "local-token-0123456789abcdef";
const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";

interface Call {
  body: unknown;
  context: { sessionId: string; enrollmentId?: string };
}

function api(calls: Call[], closed: string[]): CollectorApi {
  return {
    localToken: TOKEN,
    enrollmentId: ENROLLMENT,
    handleHook: async () => ({}),
    handleOtlp: async () => undefined,
    health: () => ({ ok: true }),
    status: () => ({ ok: true }),
    sessions: () => [],
    exportSession: () => undefined,
    mcp: async (body, context) => {
      calls.push({ body, context });
      return { status: 200, body: { jsonrpc: "2.0", id: 1, result: {} } };
    },
    mcpClose: (sessionId) => {
      closed.push(sessionId);
    },
  };
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function post(options: {
  port?: number;
  socketPath?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(options.socketPath !== undefined
          ? { socketPath: options.socketPath }
          : { host: "127.0.0.1", port: options.port }),
        path: options.path,
        method: options.method ?? "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

describe("the TCP listener", () => {
  let server: CollectorServer;
  let port: number;
  let calls: Call[];
  let closed: string[];

  beforeEach(async () => {
    calls = [];
    closed = [];
    server = createCollectorServer(api(calls, closed));
    const listening = await server.listen({ port: 0 });
    port = listening.port as number;
  });

  afterEach(async () => {
    await server.close();
  });

  it("serves /mcp to a native client", async () => {
    const reply = await post({ port, path: "/mcp", body: RPC });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toHaveProperty("result");
    expect(calls).toHaveLength(1);
  });

  it("answers a notification the gateway acknowledged with an empty body, not a 500", async () => {
    // `notifications/initialized` is sent by every MCP client right after the
    // handshake, and the control plane acknowledges it with 202 and no body,
    // which `readRpcBody` reports as undefined. `send` used to hand that to
    // JSON.stringify, get `undefined` back, and throw inside Buffer.byteLength
    // — so the outer catch turned a successful acknowledgement into a 500 on
    // every single handshake.
    const notified: Call[] = [];
    const notifyServer = createCollectorServer({
      ...api(notified, []),
      mcp: async (body, context) => {
        notified.push({ body, context });
        return { status: 202, body: undefined };
      },
    });
    const listening = await notifyServer.listen({ port: 0 });
    try {
      const reply = await post({
        port: listening.port as number,
        path: "/mcp",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      expect(reply.status).toBe(202);
      expect(reply.body).toBe("");
      expect(reply.headers["content-length"]).toBe("0");
      expect(reply.headers["mcp-session-id"]).toMatch(/^mcp_[0-9a-f]{24}$/);
    } finally {
      await notifyServer.close();
    }
  });

  it("mints a session id and hands it back, rather than taking the client's word", async () => {
    const reply = await post({ port, path: "/mcp", body: RPC });
    const minted = reply.headers["mcp-session-id"];
    expect(typeof minted).toBe("string");
    expect(minted).toMatch(/^mcp_[0-9a-f]{24}$/);
    expect(calls[0]?.context.sessionId).toBe(minted);
  });

  it("keeps the session id a client echoes back", async () => {
    const first = await post({ port, path: "/mcp", body: RPC });
    const id = first.headers["mcp-session-id"] as string;
    await post({
      port,
      path: "/mcp",
      body: RPC,
      headers: { "Mcp-Session-Id": id },
    });
    expect(calls[1]?.context.sessionId).toBe(id);
  });

  it("passes the enrollment id from a scoped path", async () => {
    await post({ port, path: `/mcp/${ENROLLMENT}`, body: RPC });
    expect(calls[0]?.context.enrollmentId).toBe(ENROLLMENT);
  });

  it("closes a session on DELETE", async () => {
    const first = await post({ port, path: "/mcp", body: RPC });
    const id = first.headers["mcp-session-id"] as string;
    const reply = await post({
      port,
      path: "/mcp",
      method: "DELETE",
      headers: { "Mcp-Session-Id": id },
    });
    expect(reply.status).toBe(204);
    expect(closed).toEqual([id]);
  });

  it("refuses a rebound request before it reads the bearer", async () => {
    const reply = await post({
      port,
      path: "/mcp",
      body: RPC,
      headers: { Host: `evil.example:${port}` },
    });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body).error).toContain("loopback Host");
    expect(calls).toEqual([]);
  });

  it("refuses a rebound request even with the right bearer", async () => {
    // The point of the guard: the bearer is not the control here. A token
    // that has leaked anywhere a page can read is enough on its own.
    const reply = await post({
      port,
      path: "/status",
      method: "GET",
      headers: { Host: "evil.example" },
    });
    expect(reply.status).toBe(403);
  });

  it("refuses a cross-origin browser caller", async () => {
    const reply = await post({
      port,
      path: "/mcp",
      body: RPC,
      headers: { Origin: "https://evil.example" },
    });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body).error).toContain("cross-origin");
    expect(calls).toEqual([]);
  });

  it("guards the routes that existed before the gateway, not only /mcp", async () => {
    for (const path of ["/health", "/status", "/sessions"]) {
      const reply = await post({
        port,
        path,
        method: "GET",
        headers: { Origin: "https://evil.example" },
      });
      expect(reply.status, path).toBe(403);
    }
  });

  it("allows a loopback origin, which a local page legitimately sends", async () => {
    const reply = await post({
      port,
      path: "/mcp",
      body: RPC,
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(reply.status).toBe(200);
  });

  it("still requires the bearer once the guard has passed", async () => {
    const reply = await post({
      port,
      path: "/mcp",
      body: RPC,
      headers: { Authorization: "Bearer wrong-token-0123456789abc" },
    });
    expect(reply.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("404s /mcp on a daemon with no gateway", async () => {
    const bare = createCollectorServer({
      ...api(calls, closed),
      mcp: undefined,
      mcpClose: undefined,
    });
    const listening = await bare.listen({ port: 0 });
    try {
      const reply = await post({
        port: listening.port as number,
        path: "/mcp",
        body: RPC,
      });
      expect(reply.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe("the Unix socket", () => {
  let dir: string;
  let server: CollectorServer;
  let calls: Call[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tacho-sock-"));
    calls = [];
    server = createCollectorServer(api(calls, []));
    await server.listen({ socketPath: join(dir, "d.sock") });
  });

  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not subject to the browser guard", async () => {
    // Node synthesises a `Host` for a socket request that the TCP guard would
    // refuse. No browser can address a Unix socket, so there is nothing to
    // guard against and the hook must keep working.
    const reply = await post({
      socketPath: join(dir, "d.sock"),
      path: "/mcp",
      body: RPC,
    });
    expect(reply.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
