import { Hono } from "hono";
import { trackRequestWork } from "@oxagen/config/request-work";
import { describe, expect, it } from "vitest";
import { createRequestAdmission, API_ADMISSION_LANES } from "@oxagen/telemetry/request-admission";
import { createApiRequestAdmission } from "../middleware/admission";
import type { AppEnv } from "../app";
import { createTestResponseTransport } from "./admission-transport";

function fixture() {
  const gate = createRequestAdmission(API_ADMISSION_LANES, () => ({
    heapUsed: 0, heapLimit: 2 ** 30, rss: 0, memoryLimit: 2 ** 31,
  }));
  const transport = createTestResponseTransport();
  const app = new Hono<AppEnv>();
  app.use("*", transport.wrap(createApiRequestAdmission(gate)));
  return { app, gate, transport };
}

describe("API test response transport", () => {
  it("completes sequential responses even when tests inspect only their status", async () => {
    const { app, gate } = fixture();
    app.post("/v1/tacho/events", (c) => c.json({ accepted: 1 }));
    for (let index = 0; index < 20; index += 1) {
      const response = await app.request("/v1/tacho/events", { method: "POST" });
      expect(response.status).toBe(200);
      expect(response.bodyUsed).toBe(false);
      expect(gate.snapshot().reservedBytes).toBe(0);
    }
    const response = await app.request("/v1/tacho/events", { method: "POST" });
    expect(await response.json()).toEqual({ accepted: 1 });
  });

  it("keeps streaming requests subject to admission until cleanup", async () => {
    const { app, gate, transport } = fixture();
    app.post("/v1/tacho/events", () => new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-type": "text/event-stream" },
    }));
    for (let index = 0; index < 4; index += 1)
      expect((await app.request("/v1/tacho/events", { method: "POST" })).status).toBe(200);
    expect((await app.request("/v1/tacho/events", { method: "POST" })).status).toBe(503);
    expect(gate.snapshot().active.ingest).toBe(4);
    await transport.cleanup();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("replaces the finalized context response before outer middleware and the client read it", async () => {
    const gate = createRequestAdmission(API_ADMISSION_LANES, () => ({
      heapUsed: 0, heapLimit: 2 ** 30, rss: 0, memoryLimit: 2 ** 31,
    }));
    const transport = createTestResponseTransport();
    const app = new Hono<AppEnv>();
    let outerBody: unknown;
    app.use("*", async (c, next) => {
      await next();
      expect(c.finalized).toBe(true);
      expect(c.res.bodyUsed).toBe(false);
      outerBody = await c.res.clone().json();
      c.header("x-outer", "preserved");
    });
    app.use("*", transport.wrap(createApiRequestAdmission(gate)));
    app.post("/created", (c) => {
      c.header("x-route", "preserved");
      return c.json({ created: true }, 201);
    });
    const response = await app.request("/created", { method: "POST" });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-route")).toBe("preserved");
    expect(response.headers.get("x-outer")).toBe("preserved");
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({ created: true });
    expect(outerBody).toEqual({ created: true });
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("reports a finite response failure and releases its reservation", async () => {
    const { app, gate } = fixture();
    const failure = new Error("Response source failed");
    let observed: Error | undefined;
    app.onError((error, c) => {
      observed = error;
      return c.json({ error: "Response failed" }, 500);
    });
    app.get("/broken", () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(failure); },
    })));
    const response = await app.request("/broken");
    expect(response.status).toBe(500);
    expect(observed).toBe(failure);
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("retains detached work after the transport finishes a finite response", async () => {
    const { app, gate } = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let detached = Promise.resolve();
    app.get("/detached", (c) => {
      detached = trackRequestWork(() => pending);
      return c.json({ accepted: true });
    });
    const response = await app.request("/detached");
    expect(response.status).toBe(200);
    expect(gate.snapshot().active.interactive).toBe(1);
    finish();
    await detached;
    expect(gate.snapshot().reservedBytes).toBe(0);
  });
});
