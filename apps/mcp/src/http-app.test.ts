import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestWork, trackRequestWork } from "@oxagen/config/request-work";
import { createRequestAdmission } from "@oxagen/telemetry/request-admission";
import { createMcpHttpApp, trackMcpDispatch } from "./http-app";

function admission() {
  return createRequestAdmission({
    control: { concurrency: 1, reserveBytes: 1 },
    tool: { concurrency: 1, reserveBytes: 1 },
  }, () => ({ heapUsed: 0, heapLimit: 1_000, rss: 0, memoryLimit: 1_000 }));
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function serve(app: ReturnType<typeof createMcpHttpApp>): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("MCP HTTP admission", () => {
  it("rejects saturation before parsing malformed bodies and preserves health", async () => {
    const budget = admission();
    const release = budget.acquire("tool");
    const handler = vi.fn();
    const url = await serve(createMcpHttpApp([], handler, budget));
    const response = await fetch(`${url}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{bad",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(handler).not.toHaveBeenCalled();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/ready`)).status).toBe(200);
    release?.();
  });

  it("keeps detached HTTP work reserved after the real client disconnects", async () => {
    const budget = admission();
    const started = deferred();
    const closed = deferred();
    const task = deferred();
    let invocation: Promise<void> = Promise.resolve();
    const url = await serve(createMcpHttpApp([], (_req, res) => {
      invocation = trackRequestWork(() => task.promise);
      res.once("close", closed.resolve);
      started.resolve();
      return Promise.resolve();
    }, budget));
    const controller = new AbortController();
    const request = fetch(`${url}/mcp`, { signal: controller.signal }).catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    await request;
    await closed.promise;
    expect(budget.snapshot().active.tool).toBe(1);
    expect((await fetch(`${url}/mcp`)).status).toBe(503);
    task.resolve();
    await invocation;
    expect(budget.snapshot().active.tool).toBe(0);
  });

  it("releases malformed bodies and enforces the body limit", async () => {
    const budget = admission();
    const handler = vi.fn();
    const url = await serve(createMcpHttpApp([], handler, budget));
    expect((await fetch(`${url}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{bad",
    })).status).toBe(400);
    expect((await fetch(`${url}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x".repeat(4 * 1024 * 1024) }),
    })).status).toBe(413);
    expect(budget.snapshot().active.tool).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves browser preflight methods and client metadata headers", async () => {
    const url = await serve(createMcpHttpApp([], vi.fn(), admission()));
    const response = await fetch(`${url}/mcp`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-mcp-client-name");
    expect(response.headers.get("access-control-expose-headers")).toContain("Retry-After");
  });

  it("keeps authentication and local-server middleware ahead of tool dispatch", async () => {
    const budget = admission();
    const handler = vi.fn((_req: Request, res: Response) => { res.json({ tool: true }); });
    const url = await serve(createMcpHttpApp([
      (req, res, next) => {
        if (req.headers.authorization !== "Bearer test") { res.sendStatus(401); return; }
        next();
      },
      (req, res, next) => {
        if (req.path === "/v1/local-servers/next") { res.sendStatus(204); return; }
        next();
      },
    ], handler, budget));
    expect((await fetch(`${url}/mcp`)).status).toBe(401);
    expect((await fetch(`${url}/v1/local-servers/next`, {
      headers: { authorization: "Bearer test" },
    })).status).toBe(204);
    expect(handler).not.toHaveBeenCalled();
    expect((await fetch(`${url}/mcp`, { headers: { authorization: "Bearer test" } })).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("serves the framework homepage before authentication", async () => {
    const auth = vi.fn();
    const url = await serve(createMcpHttpApp([auth], vi.fn(), admission(), "<p>Framework homepage</p>"));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<p>Framework homepage</p>");
    expect(auth).not.toHaveBeenCalled();
  });

  it("preserves the configured application verification challenge", async () => {
    vi.stubEnv("OPENAI_APPS_VERIFICATION_TOKEN", "test-challenge");
    const url = await serve(createMcpHttpApp([], vi.fn(), admission()));
    const response = await fetch(`${url}/.well-known/openai-apps-challenge`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test-challenge");
  });
});

describe("MCP dispatch lifetime", () => {
  function response() {
    const res = new EventEmitter();
    return Object.assign(res, { end: vi.fn(() => res) }) as unknown as Response;
  }

  it("holds active tool work after the adapter dispatches and the client disconnects", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const task = deferred();
    const res = response();
    let invocation: Promise<void> = Promise.resolve();
    const handler = trackMcpDispatch(() => {
      invocation = trackRequestWork(() => task.promise);
      return Promise.resolve();
    });
    await work.run(() => handler({} as Request, res, vi.fn()));
    work.close();
    expect(release).not.toHaveBeenCalled();
    task.resolve();
    await invocation;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("settles an adapter error response even if the adapter promise never settles", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const res = response();
    const handler = trackMcpDispatch((_req, response) => {
      response.end("error");
      return new Promise<void>(() => undefined);
    });
    await work.run(() => handler({} as Request, res, vi.fn()));
    work.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not release initialization on a disconnect before dispatch", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const task = deferred();
    const handler = trackMcpDispatch(() => task.promise);
    const pending = work.run(() => handler({} as Request, response(), vi.fn()));
    work.close();
    expect(release).not.toHaveBeenCalled();
    task.resolve();
    await pending;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("forwards dispatch errors and restores the response method", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const res = response();
    const end = res.end;
    const next = vi.fn();
    const error = new Error("dispatch failed");
    const handler = trackMcpDispatch(() => { throw error; });
    await work.run(() => handler({} as Request, res, next));
    work.close();
    expect(next).toHaveBeenCalledWith(error);
    expect(res.end).toBe(end);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retains tool work even when an adapter sends an error early", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const task = deferred();
    let invocation: Promise<void> = Promise.resolve();
    const handler = trackMcpDispatch((_req, res) => {
      invocation = trackRequestWork(() => task.promise);
      res.end("error");
      return new Promise<void>(() => undefined);
    });
    await work.run(() => handler({} as Request, response(), vi.fn()));
    work.close();
    expect(release).not.toHaveBeenCalled();
    task.resolve();
    await invocation;
    expect(release).toHaveBeenCalledTimes(1);
  });
});
