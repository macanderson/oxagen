// route.test.ts: the two routes a machine polls for local tool calls, with a
// fake broker and a fake response (#4773).
import {
  createInProcessBroker,
  LOCAL_SERVERS_NEXT_PATH,
  LOCAL_SERVERS_REPLY_PATH,
  type LongPollBroker,
} from "@oxagen/handlers/mcp-studio/local-calls/broker";
import { describe, expect, it, vi } from "vitest";
import type { MachineAuthResult } from "../auth";
import { createLocalServersRoute, type LocalServersRequest, type LocalServersRouteDeps } from "../route";
import { FakeResponse, serve } from "./http";

// apps/mcp does not depend on tacho, so the delivery type comes through the broker.
type Delivery = NonNullable<Awaited<ReturnType<LongPollBroker["next"]>>>;

const MACHINE = "tch_laptop01";
const HEADERS = { authorization: "Bearer ox_gateway_key", "x-tacho-host": MACHINE };
const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };
const ALLOWED: MachineAuthResult = { ok: true, machine: MACHINE, scope: SCOPE };
const DELIVERY = { kind: "discover", id: "n".repeat(22), deadline_ms: 1_000 } as unknown as Delivery;

function brokerWith(parts: Partial<LongPollBroker> = {}): LongPollBroker {
  return {
    connected: () => false,
    dispatch: () => Promise.reject(new Error("dispatch is not part of the route")),
    next: () => Promise.resolve(undefined),
    reply: () => ({ accepted: true }),
    release: () => false,
    ...parts,
  };
}

/** A broker with one delivery queued for MACHINE, as a call that came between two polls leaves it. */
async function brokerHolding(delivery: Delivery): Promise<LongPollBroker> {
  const broker = createInProcessBroker();
  await broker.next(MACHINE, AbortSignal.abort());
  void broker
    .dispatch(MACHINE, delivery, {
      signal: new AbortController().signal,
      pickupBy: Date.now() + 60_000,
      replyWithinMs: 60_000,
    })
    .catch(() => undefined);
  return broker;
}

function routeWith(overrides: Partial<LocalServersRouteDeps> = {}) {
  const deps: LocalServersRouteDeps = {
    authenticate: () => Promise.resolve(ALLOWED),
    broker: () => brokerWith(),
    log: vi.fn(),
    ...overrides,
  };
  return { route: createLocalServersRoute(deps), deps };
}

function poll(extra: Partial<LocalServersRequest> = {}): LocalServersRequest {
  return { method: "GET", path: LOCAL_SERVERS_NEXT_PATH, headers: HEADERS, ...extra };
}

function reply(body: unknown): LocalServersRequest {
  return { method: "POST", path: LOCAL_SERVERS_REPLY_PATH, headers: HEADERS, body };
}

describe("createLocalServersRoute", () => {
  it("passes every other path to the next middleware without reading the key", async () => {
    const authenticate = vi.fn(() => Promise.resolve(ALLOWED));
    const { route } = routeWith({ authenticate });
    await expect(serve(route, { method: "POST", path: "/mcp", headers: HEADERS })).resolves.toBe("passed");
    await expect(serve(route, { method: "GET", headers: HEADERS })).resolves.toBe("passed");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("serves the poll from the request url when express gives no path, and ignores the query", async () => {
    const { route } = routeWith();
    const answer = await serve(route, { method: "GET", url: `${LOCAL_SERVERS_NEXT_PATH}?wait=1`, headers: HEADERS });
    expect(answer).toMatchObject({ status: 204 });
  });

  it("treats a request with no method as a GET", async () => {
    const { route } = routeWith();
    await expect(serve(route, poll({ method: undefined }))).resolves.toMatchObject({ status: 204 });
  });

  it("answers 405 with the allowed method for the wrong one", async () => {
    const authenticate = vi.fn(() => Promise.resolve(ALLOWED));
    const { route } = routeWith({ authenticate });
    const onPoll = await serve(route, poll({ method: "POST" }));
    const onReply = await serve(route, reply(undefined));
    const getReply = await serve(route, { method: "get", path: LOCAL_SERVERS_REPLY_PATH, headers: HEADERS });
    expect(onPoll).toMatchObject({ status: 405, headers: { allow: "GET" } });
    expect(onReply).toMatchObject({ status: 204 });
    expect(getReply).toMatchObject({ status: 405, headers: { allow: "POST" } });
    if (getReply === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(getReply.body)).toEqual({
      error: { code: "method_not_allowed", message: `Use POST on ${LOCAL_SERVERS_REPLY_PATH}.` },
    });
  });

  it("sends an auth refusal as it is, and never asks the broker", async () => {
    const next = vi.fn(() => Promise.resolve(undefined));
    const refusal: MachineAuthResult = {
      ok: false,
      status: 403,
      body: { error: { code: "forbidden", message: "Forbidden: Tacho host suspended", reason: "host_suspended" } },
    };
    const { route } = routeWith({ authenticate: () => Promise.resolve(refusal), broker: () => brokerWith({ next }) });
    const answer = await serve(route, poll());
    expect(answer).toMatchObject({ status: 403, headers: { "content-type": "application/json" } });
    if (answer === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(answer.body)).toEqual(refusal.body);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 204 with no body when no call came within the wait", async () => {
    const next = vi.fn((_machine: string, _signal: AbortSignal, _waitMs?: number) => Promise.resolve(undefined));
    const { route } = routeWith({ broker: () => brokerWith({ next }), waitMs: 5 });
    await expect(serve(route, poll())).resolves.toEqual({ status: 204, headers: {}, body: "" });
    expect(next).toHaveBeenCalledWith(MACHINE, expect.any(AbortSignal), 5);
  });

  it("answers 200 with the delivery as JSON that no cache keeps", async () => {
    const { route } = routeWith({ broker: () => brokerWith({ next: () => Promise.resolve(DELIVERY) }) });
    const answer = await serve(route, poll());
    expect(answer).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
    if (answer === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(answer.body)).toEqual(DELIVERY);
  });

  it("stops waiting and writes nothing when the machine hangs up", async () => {
    let seen: AbortSignal | undefined;
    const next = (_machine: string, signal: AbortSignal) =>
      new Promise<Delivery | undefined>((resolve) => {
        seen = signal;
        signal.addEventListener("abort", () => resolve(undefined));
      });
    const release = vi.fn(() => true);
    const { route } = routeWith({ broker: () => brokerWith({ next, release }) });
    const res = new FakeResponse();
    route(poll(), res, () => undefined);
    await vi.waitFor(() => expect(seen).toBeDefined());
    res.hangUp();
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen?.aborted).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it("gives the delivery back when the machine hangs up after the broker handed it over", async () => {
    const next = (_machine: string, signal: AbortSignal) =>
      new Promise<Delivery | undefined>((resolve) => {
        signal.addEventListener("abort", () => resolve(DELIVERY));
      });
    const release = vi.fn((_machine: string, _delivery: Delivery) => true);
    const log = vi.fn();
    const { route } = routeWith({ broker: () => brokerWith({ next, release }), log });
    const res = new FakeResponse();
    const writeHead = vi.spyOn(res, "writeHead");
    route(poll(), res, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    res.hangUp();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(MACHINE, DELIVERY));
    expect(writeHead).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("local_servers.delivery_released", { machine: MACHINE });
  });

  it("takes nothing from the broker when the machine hangs up during the key check", async () => {
    const broker = await brokerHolding(DELIVERY);
    let allow: (result: MachineAuthResult) => void = () => undefined;
    const authenticate = () =>
      new Promise<MachineAuthResult>((resolve) => {
        allow = resolve;
      });
    const { route } = routeWith({ authenticate, broker: () => broker });
    const res = new FakeResponse();
    const writeHead = vi.spyOn(res, "writeHead");
    route(poll(), res, () => undefined);
    res.hangUp();
    allow(ALLOWED);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writeHead).not.toHaveBeenCalled();

    // The machine's next poll takes the delivery the first poll never wrote.
    const again = await serve(routeWith({ broker: () => broker }).route, poll());
    expect(again).toMatchObject({ status: 200 });
    if (again === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(again.body)).toEqual(DELIVERY);
  });

  it("treats a connection already gone when the route starts as a hangup", async () => {
    const broker = await brokerHolding(DELIVERY);
    const { route } = routeWith({ broker: () => broker });
    const res = new FakeResponse();
    res.destroyed = true;
    const writeHead = vi.spyOn(res, "writeHead");
    route(poll(), res, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writeHead).not.toHaveBeenCalled();
    await expect(serve(route, poll())).resolves.toMatchObject({ status: 200 });
  });

  it("answers 204 to a reply the broker accepts, for the key's machine", async () => {
    const accept = vi.fn((_machine: string, _body: unknown) => ({ accepted: true as const }));
    const { route } = routeWith({ broker: () => brokerWith({ reply: accept }) });
    const body = { kind: "result", id: "n".repeat(22) };
    await expect(serve(route, reply(body))).resolves.toMatchObject({ status: 204, body: "" });
    expect(accept).toHaveBeenCalledWith(MACHINE, body);
  });

  it("answers 400 to a reply that does not parse, and logs the refusal", async () => {
    const log = vi.fn();
    const { route } = routeWith({
      broker: () => brokerWith({ reply: () => ({ accepted: false, reason: "invalid" }) }),
      log,
    });
    const answer = await serve(route, reply({ kind: "nonsense" }));
    expect(answer).toMatchObject({ status: 400 });
    if (answer === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "bad_request", reason: "invalid" } });
    expect(log).toHaveBeenCalledWith("local_servers.reply_refused", { machine: MACHINE, reason: "invalid" });
  });

  it("answers 409 to a reply no call waits for", async () => {
    const { route } = routeWith({
      broker: () => brokerWith({ reply: () => ({ accepted: false, reason: "unknown_id" }) }),
    });
    const answer = await serve(route, reply({ kind: "result" }));
    expect(answer).toMatchObject({ status: 409 });
    if (answer === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "conflict", reason: "unknown_id" } });
  });

  it("answers 500 and logs when the key check throws", async () => {
    const log = vi.fn();
    const { route } = routeWith({ authenticate: () => Promise.reject(new Error("database unreachable")), log });
    const answer = await serve(route, poll());
    expect(answer).toMatchObject({ status: 500 });
    if (answer === "passed") throw new Error("the route passed a request on its own path");
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "internal_error" } });
    expect(log).toHaveBeenCalledWith("local_servers.route_failed", {
      path: LOCAL_SERVERS_NEXT_PATH,
      error: "database unreachable",
    });
  });

  it("logs a thrown value that is not an Error by its text", async () => {
    const log = vi.fn();
    const { route } = routeWith({ authenticate: () => Promise.reject("socket closed"), log });
    await expect(serve(route, poll())).resolves.toMatchObject({ status: 500 });
    expect(log).toHaveBeenCalledWith("local_servers.route_failed", {
      path: LOCAL_SERVERS_NEXT_PATH,
      error: "socket closed",
    });
  });

  it("writes nothing to a response that has already ended, and gives its delivery back", async () => {
    const release = vi.fn((_machine: string, _delivery: Delivery) => true);
    const { route } = routeWith({ broker: () => brokerWith({ next: () => Promise.resolve(DELIVERY), release }) });
    const res = new FakeResponse();
    res.writableEnded = true;
    const writeHead = vi.spyOn(res, "writeHead");
    route(poll(), res, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writeHead).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(MACHINE, DELIVERY);
  });

  it("gives the delivery back when the connection is gone but its close event has not fired", async () => {
    const release = vi.fn((_machine: string, _delivery: Delivery) => true);
    const res = new FakeResponse();
    const next = () => {
      res.destroyed = true;
      return Promise.resolve(DELIVERY);
    };
    const { route } = routeWith({ broker: () => brokerWith({ next, release }) });
    const writeHead = vi.spyOn(res, "writeHead");
    route(poll(), res, () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writeHead).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(MACHINE, DELIVERY);
  });

  it("runs the poll hook for the machine and its workspace beside the wait (#4772)", async () => {
    const onPoll = vi.fn(() => Promise.resolve());
    const next = vi.fn(() => Promise.resolve(undefined));
    const { route } = routeWith({ broker: () => brokerWith({ next }), onPoll });
    await expect(serve(route, poll())).resolves.toMatchObject({ status: 204 });
    expect(onPoll).toHaveBeenCalledWith({ machine: MACHINE, scope: SCOPE });
    expect(next).toHaveBeenCalled();
  });

  it("answers the poll and logs when the poll hook fails", async () => {
    const onPoll = vi.fn(() => Promise.reject(new Error("claim failed")));
    const { route, deps } = routeWith({ onPoll });
    await expect(serve(route, poll())).resolves.toMatchObject({ status: 204 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.log).toHaveBeenCalledWith("local_servers.poll_work_failed", {
      machine: MACHINE,
      error: "claim failed",
    });
  });

  it("runs no poll hook for a reply or a refused key", async () => {
    const onPoll = vi.fn(() => Promise.resolve());
    const { route } = routeWith({ onPoll });
    await serve(route, reply({}));
    const refused = routeWith({
      onPoll,
      authenticate: () =>
        Promise.resolve({ ok: false, status: 401, body: { error: { code: "unauthorized", message: "Missing credentials" } } }),
    });
    await serve(refused.route, poll());
    expect(onPoll).not.toHaveBeenCalled();
  });

  it("asks for the server's discovery after a reply that says its tools changed (#4772)", async () => {
    const onToolsChanged = vi.fn(() => Promise.resolve());
    const { route } = routeWith({
      broker: () => brokerWith({ reply: () => ({ accepted: true, toolsChanged: { server: "files" } }) }),
      onToolsChanged,
    });
    await expect(serve(route, reply({}))).resolves.toMatchObject({ status: 204 });
    expect(onToolsChanged).toHaveBeenCalledWith({ machine: MACHINE, scope: SCOPE, server: "files" });
  });

  it("answers the reply and logs when the rediscovery fails", async () => {
    const onToolsChanged = vi.fn(() => Promise.reject(new Error("no seams")));
    const { route, deps } = routeWith({
      broker: () => brokerWith({ reply: () => ({ accepted: true, toolsChanged: { server: "files" } }) }),
      onToolsChanged,
    });
    await expect(serve(route, reply({}))).resolves.toMatchObject({ status: 204 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.log).toHaveBeenCalledWith("local_servers.tools_changed_failed", {
      machine: MACHINE,
      server: "files",
      error: "no seams",
    });
  });

  it("asks for no discovery after a reply that reports no change", async () => {
    const onToolsChanged = vi.fn(() => Promise.resolve());
    const { route } = routeWith({ onToolsChanged });
    await serve(route, reply({}));
    expect(onToolsChanged).not.toHaveBeenCalled();
  });

  it("runs without a log", async () => {
    const route = createLocalServersRoute({
      authenticate: () => Promise.resolve(ALLOWED),
      broker: () => brokerWith({ reply: () => ({ accepted: false, reason: "wrong_kind" }) }),
    });
    await expect(serve(route, reply({}))).resolves.toMatchObject({ status: 409 });
  });
});
