import { describe, expect, it, vi } from "vitest";
import { Hono, type Context } from "hono";
import { trackRequestWork } from "@oxagen/config/request-work";
import { createRequestAdmission, API_ADMISSION_LANES } from "@oxagen/telemetry/request-admission";
import { apiAdmissionLane, createApiRequestAdmission } from "./admission";
import type { AppEnv } from "../app";

function fixture(overloaded = false) {
  const gate = createRequestAdmission(API_ADMISSION_LANES, () => ({
    heapUsed: overloaded ? 2 ** 30 : 0, heapLimit: 2 ** 30, rss: 0, memoryLimit: 2 ** 31,
  }));
  const app = new Hono<AppEnv>();
  app.use("*", createApiRequestAdmission(gate));
  return { app, gate };
}

describe("API admission", () => {
  it("refuses before consuming a body or calling a handler", async () => {
    const { app } = fixture(true);
    const handler = vi.fn((c: Context<AppEnv>) => c.json({ ok: true }));
    app.post("/v1/tacho/events", handler);
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const request = new Request("http://localhost/v1/tacho/events", {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.fetch(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect((await response.json()).error.code).toBe("service_overloaded");
    expect(handler).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    await request.body?.cancel();
  });

  it("keeps liveness and preflight available during overload", async () => {
    const { app } = fixture(true);
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/health/ready", (c) => c.json({ ready: false }, 503));
    app.options("/mcp", (c) => c.body(null, 204));
    expect((await app.request("/health")).status).toBe(200);
    expect(await (await app.request("/health/ready")).json()).toEqual({ ready: false });
    expect((await app.request("/mcp", { method: "OPTIONS" })).status).toBe(204);
  });

  it("releases JSON and empty responses", async () => {
    const { app, gate } = fixture();
    app.get("/json", (c) => c.json({ ok: true }));
    app.get("/empty", (c) => c.body(null, 204));
    await (await app.request("/json")).text();
    await app.request("/empty");
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("holds a streaming reservation until cancellation", async () => {
    const { app, gate } = fixture();
    const cancel = vi.fn();
    app.get("/stream", () => new Response(new ReadableStream({ cancel })));
    const response = await app.request("/stream");
    expect(gate.snapshot().active.interactive).toBe(1);
    await response.body?.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("releases stream failures", async () => {
    const { app, gate } = fixture();
    app.get("/stream", () => new Response(new ReadableStream({ pull() { throw new Error("broken"); } })));
    const response = await app.request("/stream");
    await expect(response.text()).rejects.toThrow("broken");
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("releases after a handler throws and its error response completes", async () => {
    const { app, gate } = fixture();
    app.onError((_error, c) => c.json({ error: "failed" }, 500));
    app.get("/failure", () => { throw new Error("handler failed"); });
    const response = await app.request("/failure");
    expect(response.status).toBe(500);
    await response.text();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("keeps a cancelled request reserved while its handler still owns work", async () => {
    const { app, gate } = fixture();
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    app.get("/slow", async (c) => {
      started();
      await pending;
      return c.body(null, 204);
    });
    const controller = new AbortController();
    const response = app.request("/slow", { signal: controller.signal });
    await entered;
    controller.abort();
    expect(gate.snapshot().active.interactive).toBe(1);
    finish();
    await response;
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it.each([undefined, "1"])("cancels oversized input with declared length %s", async (length) => {
    const { app, gate } = fixture();
    const handler = vi.fn((c: Context<AppEnv>) => c.json({ ok: true }));
    app.post("/json", handler);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(1024 * 1024));
    });
    const cancel = vi.fn();
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const request = new Request("http://localhost/json", {
      method: "POST", body, duplex: "half",
      headers: length === undefined ? {} : { "content-length": length },
    } as RequestInit & { duplex: "half" });
    const response = await app.fetch(request);
    expect(response.status).toBe(413);
    await response.text();
    expect(handler).not.toHaveBeenCalled();
    expect(pull.mock.calls.length).toBeLessThanOrEqual(6);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("preserves accepted bytes and corrects the length for stricter route limits", async () => {
    const { app, gate } = fixture();
    app.post("/json", async (c) => c.json({
      input: await c.req.json(), length: c.req.header("content-length"),
    }));
    const text = JSON.stringify({ value: "ok" });
    const request = new Request("http://localhost/json", {
      method: "POST", body: text, headers: { "content-length": "1" },
    });
    const response = await app.fetch(request);
    expect(await response.json()).toEqual({ input: { value: "ok" }, length: String(text.length) });
    expect(gate.snapshot().reservedBytes).toBe(0);
    expect(request.body?.locked).toBe(false);
  });

  it("accepts exactly the body ceiling", async () => {
    const { app, gate } = fixture();
    app.post("/bytes", async (c) => c.json({ size: (await c.req.arrayBuffer()).byteLength }));
    const response = await app.request("/bytes", {
      method: "POST", body: new Uint8Array(4 * 1024 * 1024),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: 4 * 1024 * 1024 });
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("cancels a declared oversized body without reading it", async () => {
    const { app, gate } = fixture();
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = await app.fetch(new Request("http://localhost/json", {
      method: "POST", body, duplex: "half",
      headers: { "content-length": String(4 * 1024 * 1024 + 1) },
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("releases input reader and admission after a stream failure", async () => {
    const { app, gate } = fixture();
    app.onError((_error, c) => c.json({ error: "body failed" }, 400));
    const body = new ReadableStream<Uint8Array>({
      pull() { throw new Error("input broken"); },
    }, { highWaterMark: 0 });
    const response = await app.fetch(new Request("http://localhost/json", {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(400);
    await response.text();
    expect(body.locked).toBe(false);
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it.each(["complete", "cancel"])("retains detached work after response %s", async (ending) => {
    const { app, gate } = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let detached = Promise.resolve();
    app.get("/detached", (c) => {
      detached = trackRequestWork(() => pending);
      return ending === "complete"
        ? c.json({ accepted: true })
        : new Response(new ReadableStream<Uint8Array>());
    });
    const response = await app.request("/detached");
    if (ending === "complete") await response.text();
    else await response.body?.cancel();
    expect(gate.snapshot().active.interactive).toBe(1);
    finish();
    await detached;
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("admits several Inngest step calls at once, and refuses the one past the lane", () => {
    // Inngest posts one call per step and treats a 503 as a failed attempt,
    // so a lane of two refused a third of its calls in production.
    const { gate } = fixture();
    const held = Array.from({ length: API_ADMISSION_LANES.background.concurrency }, () => gate.acquire("background"));
    expect(held.every((release) => release !== null)).toBe(true);
    expect(gate.acquire("background")).toBeNull();
    expect(gate.snapshot().active.background).toBe(API_ADMISSION_LANES.background.concurrency);
    expect(API_ADMISSION_LANES.background.concurrency).toBeGreaterThanOrEqual(8);
    for (const release of held) release?.();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("separates expensive jobs from machine control and ingestion", () => {
    expect(apiAdmissionLane("/api/inngest")).toBe("background");
    expect(apiAdmissionLane("/v1/tacho/events")).toBe("ingest");
    expect(apiAdmissionLane("/v1/telemetry/stella/operational")).toBe("ingest");
    expect(apiAdmissionLane("/v1/tacho/commands")).toBe("control");
    expect(apiAdmissionLane("/v1/tacho/bundle")).toBe("control");
    expect(apiAdmissionLane("/v1/other")).toBe("interactive");
    expect(apiAdmissionLane("/v1/assistant/attachments/upload")).toBe("upload");
  });
});
