import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StellaEngineClient } from "@oxagen/stella-engine-client";
import { EngineUnavailableError } from "../runtime/engine/client";
import {
  createAssistantEngineProbe,
  ENGINE_PROBE_ATTEMPTS,
  ENGINE_PROBE_TIMEOUT_MS,
} from "./assistant.engine.get";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "r-1",
  surface: "api" as const,
  messageId: null,
};

function clientWith(fetchImpl: typeof fetch): StellaEngineClient {
  return new StellaEngineClient({
    baseUrl: "http://engine.oxagen.internal:8080",
    token: "t",
    fetchImpl,
  });
}

function handlerOver(fetchImpl: typeof fetch) {
  return createAssistantEngineProbe({
    client: () => clientWith(fetchImpl),
    now: () => NOW,
  });
}

describe("get_assistant_engine", () => {
  it("reports the state the engine answered, on the first attempt", async () => {
    const probe = handlerOver(
      async () =>
        new Response(JSON.stringify({ state: "ready" }), { status: 200 }),
    );
    await expect(probe({}, CTX)).resolves.toEqual({
      state: "ready",
      endpoint: "engine.oxagen.internal:8080",
      attempts: 1,
      error: null,
      checkedAt: NOW.toISOString(),
      incident: null,
    });
  });

  it("reports starting or draining as the engine's own word, from a 503", async () => {
    const probe = handlerOver(
      async () =>
        new Response(JSON.stringify({ state: "draining" }), { status: 503 }),
    );
    await expect(probe({}, CTX)).resolves.toMatchObject({
      state: "draining",
      attempts: 1,
    });
  });

  it("reports unreachable after three attempts with the last error's code (negative)", async () => {
    let calls = 0;
    const probe = handlerOver(async () => {
      calls += 1;
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
    });
    await expect(probe({}, CTX)).resolves.toEqual({
      state: "unreachable",
      endpoint: "engine.oxagen.internal:8080",
      attempts: ENGINE_PROBE_ATTEMPTS,
      error: "ECONNREFUSED",
      checkedAt: NOW.toISOString(),
      incident: null,
    });
    expect(calls).toBe(ENGINE_PROBE_ATTEMPTS);
  });

  it("recovers on a later attempt and reports how many it took", async () => {
    let calls = 0;
    const probe = handlerOver(async () => {
      calls += 1;
      if (calls < 3)
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return new Response(JSON.stringify({ state: "ready" }), { status: 200 });
    });
    await expect(probe({}, CTX)).resolves.toMatchObject({
      state: "ready",
      attempts: 3,
      error: null,
    });
  });

  it("reports unconfigured, with no attempt, when the engine has no address", async () => {
    const probe = createAssistantEngineProbe({
      client: () => {
        throw new EngineUnavailableError("STELLA_SERVE_TOKEN is not set");
      },
      now: () => NOW,
    });
    await expect(probe({}, CTX)).resolves.toEqual({
      state: "unconfigured",
      endpoint: null,
      attempts: 0,
      error: "engine_unavailable",
      checkedAt: NOW.toISOString(),
      incident: null,
    });
  });

  describe("with a hanging engine", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("gives each attempt the connect timeout and reports the timeout as the error", async () => {
      const probe = handlerOver(() => new Promise<Response>(() => undefined));
      const answer = probe({}, CTX);
      await vi.advanceTimersByTimeAsync(
        ENGINE_PROBE_TIMEOUT_MS * ENGINE_PROBE_ATTEMPTS + 10,
      );
      await expect(answer).resolves.toMatchObject({
        state: "unreachable",
        attempts: ENGINE_PROBE_ATTEMPTS,
        error: "ETIMEDOUT",
      });
    });
  });
});
