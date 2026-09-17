import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StellaEngineClient } from "@oxagen/stella-engine-client";
import { EngineUnavailableError } from "../runtime/engine/client";
import {
  createAssistantEngineProbe,
  ENGINE_PROBE_ATTEMPTS,
  ENGINE_PROBE_BACKOFF_MS,
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

/** Every backoff this probe waited, in order. */
let slept: number[] = [];

beforeEach(() => {
  slept = [];
});

function handlerOver(fetchImpl: typeof fetch) {
  return createAssistantEngineProbe({
    client: () => clientWith(fetchImpl),
    now: () => NOW,
    // The backoff is under test on its own; elsewhere it is recorded and
    // skipped so a retry test is not also a clock test.
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 0,
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

  // Three attempts fired back to back at a two-second ceiling are three
  // requests in six seconds at a server already failing to answer in two.
  it("waits between attempts, doubling, and not after the last one", async () => {
    const probe = handlerOver(async () => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    await probe({}, CTX);
    expect(slept).toEqual([
      ENGINE_PROBE_BACKOFF_MS,
      ENGINE_PROBE_BACKOFF_MS * 2,
    ]);
  });

  it("jitters the backoff so callers that failed together do not retry together", async () => {
    const waits: number[][] = [];
    for (const r of [0, 0.5, 1]) {
      const seen: number[] = [];
      const probe = createAssistantEngineProbe({
        client: () =>
          clientWith(async () => {
            throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          }),
        now: () => NOW,
        sleep: async (ms) => {
          seen.push(ms);
        },
        random: () => r,
      });
      await probe({}, CTX);
      waits.push(seen);
    }
    // Full jitter: the wait falls in (ceiling/2, ceiling], never above it.
    expect(waits[0]![0]).toBe(ENGINE_PROBE_BACKOFF_MS);
    expect(waits[2]![0]).toBe(ENGINE_PROBE_BACKOFF_MS / 2);
    expect(new Set(waits.map((w) => w[0])).size).toBe(3);
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

    // Without this the probe gives up on the clock and leaves the request in
    // flight: three orphaned requests per caller against a service that is
    // already the reason the probe is running.
    it("aborts the request it gave up on, once per attempt", async () => {
      const aborted: boolean[] = [];
      const probe = createAssistantEngineProbe({
        client: () =>
          clientWith((_url, init) => {
            const signal = (init as RequestInit | undefined)?.signal;
            return new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted.push(true);
                reject(
                  Object.assign(new Error("aborted"), { code: "ABORT_ERR" }),
                );
              });
            });
          }),
        now: () => NOW,
        sleep: async () => undefined,
        random: () => 0,
      });
      const answer = probe({}, CTX);
      await vi.advanceTimersByTimeAsync(
        ENGINE_PROBE_TIMEOUT_MS * ENGINE_PROBE_ATTEMPTS + 10,
      );
      await expect(answer).resolves.toMatchObject({
        state: "unreachable",
        attempts: ENGINE_PROBE_ATTEMPTS,
      });
      expect(aborted).toHaveLength(ENGINE_PROBE_ATTEMPTS);
    });
  });
});
