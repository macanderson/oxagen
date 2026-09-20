import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  CircuitBreaker,
  CircuitOpenError,
  getBreaker,
  __resetBreakerRegistry,
} from "./circuit-breaker";
import { readModelCallFrames } from "./cost-frames";
import { guardClickhouseClient } from "./clickhouse-breaker-client";

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@clickhouse/client", () => ({ createClient: h.create }));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    CLICKHOUSE_URL: "http://fixture",
    CLICKHOUSE_USERNAME: "fixture",
    CLICKHOUSE_PASSWORD: "fixture",
    CLICKHOUSE_DATABASE: "fixture",
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 100,
    CIRCUIT_BREAKER_SUCCESS_THRESHOLD: 1,
  }),
}));
import { clickhouse, closeClickhouse } from "./clickhouse";
import {
  dedicatedClickhouse,
  closeDedicatedClickhouse,
} from "./data-plane-client";

function rawClient() {
  return {
    query: vi.fn(async () => ({
      json: async () => [],
      text: async () => "",
      close: vi.fn(),
    })),
    insert: vi.fn(async () => ({ executed: true })),
    command: vi.fn(async () => ({})),
    exec: vi.fn(async () => ({ stream: Readable.from([]) })),
    ping: vi.fn(async () => ({ success: true })),
    close: vi.fn(async () => undefined),
  };
}
beforeEach(async () => {
  await closeClickhouse();
  closeDedicatedClickhouse();
  __resetBreakerRegistry();
  vi.resetAllMocks();
});

describe("ClickHouse client breaker", () => {
  it("lets a cost-frame read recover through the single client probe", async () => {
    vi.useFakeTimers();
    try {
      const raw = rawClient();
      h.create.mockReturnValue(raw);
      clickhouse();
      const breaker = getBreaker("clickhouse");
      breaker.begin().fail("down");
      breaker.begin().fail("down");
      vi.advanceTimersByTime(101);
      await expect(
        readModelCallFrames({
          orgId: "00000000-0000-4000-8000-000000000001",
          run: {
            kind: "ledger",
            runUuid: "00000000-0000-4000-8000-000000000002",
          },
        }),
      ).resolves.toEqual([]);
      expect(raw.query).toHaveBeenCalledOnce();
      expect(breaker.getState()).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards shared query, insert, and command paths at construction", async () => {
    const raw = rawClient();
    raw.insert.mockRejectedValue(new Error("store down"));
    h.create.mockReturnValue(raw);
    const client = clickhouse();
    await expect(
      client.insert({ table: "events", values: [{}] }),
    ).rejects.toThrow("store down");
    await expect(
      client.insert({ table: "events", values: [{}] }),
    ).rejects.toThrow("store down");
    await expect(client.query({ query: "SELECT 1" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    await expect(
      client.command({ query: "ALTER TABLE events ADD COLUMN x UInt8" }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(raw.query).not.toHaveBeenCalled();
    expect(raw.command).not.toHaveBeenCalled();
    await client.close();
    expect(raw.close).toHaveBeenCalled();
  });
  it("counts body failures without successful headers resetting the failure streak", async () => {
    const raw = rawClient();
    raw.query.mockResolvedValue({
      json: async () => {
        throw new Error("truncated body");
      },
      text: async () => "",
      close: vi.fn(),
    });
    const breaker = new CircuitBreaker("body", { failureThreshold: 2 });
    const client = guardClickhouseClient(
      raw as unknown as ClickHouseClient,
      breaker,
    );
    for (let i = 0; i < 2; i++)
      await expect(
        (await client.query({ query: "SELECT 1" })).json(),
      ).rejects.toThrow("truncated body");
    expect(breaker.getState()).toBe("open");
    await expect(client.query({ query: "SELECT 1" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(raw.query).toHaveBeenCalledTimes(2);
  });
  it("holds the half-open probe until the response body completes", async () => {
    let now = 0;
    const breaker = new CircuitBreaker("probe", {
      failureThreshold: 1,
      resetTimeoutMs: 10,
      now: () => now,
    });
    await expect(
      breaker.exec(async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow();
    now = 11;
    const raw = rawClient();
    const client = guardClickhouseClient(
      raw as unknown as ClickHouseClient,
      breaker,
    );
    const result = await client.query({ query: "SELECT 1" });
    await expect(
      client.insert({ table: "events", values: [{}] }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(breaker.getState()).toBe("half-open");
    await result.json();
    expect(breaker.getState()).toBe("closed");
  });
  it("observes streamed failures without buffering the stream", async () => {
    const stream = new Readable({ read() {} });
    const raw = rawClient();
    raw.exec.mockResolvedValue({ stream });
    const breaker = new CircuitBreaker("stream", { failureThreshold: 1 });
    const client = guardClickhouseClient(
      raw as unknown as ClickHouseClient,
      breaker,
    );
    expect((await client.exec({ query: "SELECT 1" })).stream).toBe(stream);
    stream.emit("error", new Error("connection lost"));
    expect(breaker.getState()).toBe("open");
  });
  it("counts a half-open query stream failure and releases closed results", async () => {
    let now = 0;
    const breaker = new CircuitBreaker("query-stream", {
      failureThreshold: 1,
      resetTimeoutMs: 10,
      now: () => now,
    });
    breaker.begin().fail("down");
    now = 11;
    const stream = new Readable({ read() {} });
    const raw = rawClient();
    const result = {
      json: async () => [],
      text: async () => "body",
      close: vi.fn(),
      stream: () => stream,
    };
    raw.query.mockResolvedValue(result);
    const client = guardClickhouseClient(
      raw as unknown as ClickHouseClient,
      breaker,
    );
    const abandoned = await client.query({ query: "SELECT 1" });
    abandoned.close();
    expect(result.close).toHaveBeenCalledOnce();
    expect(breaker.getState()).toBe("half-open");
    const probe = await client.query({ query: "SELECT 1" });
    expect(probe.stream()).toBe(stream);
    await expect(client.query({ query: "SELECT 1" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    stream.emit("error", new Error("query stream lost"));
    expect(breaker.getState()).toBe("open");
    now = 22;
    expect(await (await client.query({ query: "SELECT 1" })).text()).toBe(
      "body",
    );
    expect(breaker.getState()).toBe("closed");
  });
  it("counts unsuccessful health checks", async () => {
    const raw = rawClient();
    raw.ping.mockResolvedValue({ success: false });
    const breaker = new CircuitBreaker("ping", { failureThreshold: 1 });
    const client = guardClickhouseClient(
      raw as unknown as ClickHouseClient,
      breaker,
    );
    expect((await client.ping()).success).toBe(false);
    expect(breaker.getState()).toBe("open");
  });
  it("isolates dedicated tenants and credential rotations from the shared breaker", async () => {
    const first = rawClient();
    first.command.mockRejectedValue(new Error("dedicated down"));
    const second = rawClient();
    const shared = rawClient();
    const rotated = rawClient();
    h.create
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(shared)
      .mockReturnValueOnce(rotated);
    const config = {
      url: "http://dedicated",
      username: "fixture",
      password: "fixture",
      database: "fixture",
    };
    const a = dedicatedClickhouse({
      orgId: "org-a",
      config,
      configDigest: "first",
    });
    const b = dedicatedClickhouse({
      orgId: "org-b",
      config,
      configDigest: "first",
    });
    for (let i = 0; i < 2; i++)
      await expect(a.command({ query: "SELECT 1" })).rejects.toThrow(
        "dedicated down",
      );
    await expect(a.query({ query: "SELECT 1" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    await b.command({ query: "SELECT 1" });
    await clickhouse().command({ query: "SELECT 1" });
    await dedicatedClickhouse({
      orgId: "org-a",
      config,
      configDigest: "rotated",
    }).command({ query: "SELECT 1" });
    expect(second.command).toHaveBeenCalledOnce();
    expect(shared.command).toHaveBeenCalledOnce();
    expect(rotated.command).toHaveBeenCalledOnce();
  });
  it("settles one lease once and releases cancelled probes without claiming recovery", async () => {
    let now = 0;
    const breaker = new CircuitBreaker("cancel", {
      failureThreshold: 1,
      resetTimeoutMs: 1,
      now: () => now,
    });
    const failed = breaker.begin();
    failed.fail("down");
    failed.succeed();
    expect(breaker.getState()).toBe("open");
    now = 2;
    const cancelled = breaker.begin();
    cancelled.cancel();
    expect(breaker.getState()).toBe("half-open");
    const next = breaker.begin();
    next.succeed();
    expect(breaker.getState()).toBe("closed");
  });
});
