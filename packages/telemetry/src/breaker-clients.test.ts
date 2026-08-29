import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ClickHouse layer so no real client/env is needed and we can assert
// that a breaker transition is recorded as an `events` row.
const { insertEvents } = vi.hoisted(() => ({
  insertEvents: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));
vi.mock("./clickhouse", () => ({
  insertEvents,
  NIL_UUID: "00000000-0000-0000-0000-000000000000",
}));

import { neo4jBreaker, stripeBreaker } from "./breaker-clients";
import { __resetBreakerRegistry } from "./circuit-breaker";

const boom = () => Promise.reject(new Error("down"));

describe("breaker-clients", () => {
  beforeEach(() => {
    __resetBreakerRegistry();
    insertEvents.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("neo4j and stripe are isolated per-key breakers", () => {
    expect(neo4jBreaker().key).toBe("neo4j");
    expect(stripeBreaker().key).toBe("stripe");
    expect(neo4jBreaker()).toBe(neo4jBreaker()); // registry returns same instance
  });

  it("records a breaker open transition as an append-only ClickHouse event", async () => {
    const b = neo4jBreaker(); // default threshold 5
    for (let i = 0; i < 5; i++) {
      await expect(b.exec(boom)).rejects.toThrow("down");
    }
    // Emission is fire-and-forget; let the microtask flush.
    await Promise.resolve();

    expect(insertEvents).toHaveBeenCalledTimes(1);
    const rows = insertEvents.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    const row = rows[0]!;
    expect(row).toMatchObject({
      event_type: "circuit_breaker.open",
      source_system: "circuit-breaker",
      org_id: "00000000-0000-0000-0000-000000000000",
      workspace_id: "00000000-0000-0000-0000-000000000000",
    });
    const payload = JSON.parse(row.payload as string);
    expect(payload).toMatchObject({
      key: "neo4j",
      to: "open",
      failureCount: 5,
    });
  });

  it("falls back to a stderr line when ClickHouse itself is also down", async () => {
    // insertEvents() rejecting exercises emitTransitionToClickHouse's own
    // .catch() — the "ClickHouse ALSO down" last-resort stderr path.
    insertEvents.mockImplementationOnce(() =>
      Promise.reject(new Error("ch down")),
    );
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const b = stripeBreaker(); // default threshold 5
    for (let i = 0; i < 5; i++) {
      await expect(b.exec(boom)).rejects.toThrow("down");
    }
    // Emission + its rejection handler are both fire-and-forget microtasks.
    await Promise.resolve();
    await Promise.resolve();

    const failedEmitLine = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("[clickhouse emit failed]"));
    expect(failedEmitLine).toBeDefined();
    expect(failedEmitLine).toContain("stripe");
  });

  it("omits ` err=` when a transition carries no error (open→half-open probe)", async () => {
    // The open→half-open transition (triggered by exec() once the reset window
    // has elapsed) always fires onTransition with error=undefined — exercises
    // the falsy arm of the `t.error ? ... : ""` ternary in both
    // emitTransitionToClickHouse and onTransition (breaker-clients.ts:55,65).
    // ClickHouse is kept down for every transition in this test so
    // emitTransitionToClickHouse's own .catch() (line 50-58) runs for BOTH the
    // initial (errored) open transition and the (error-free) half-open one,
    // covering the ternary's falsy arm at line 55 too.
    insertEvents.mockImplementation(() => Promise.reject(new Error("ch down")));
    const dateSpy = vi.spyOn(Date, "now");
    let time = 1_000_000;
    dateSpy.mockImplementation(() => time);
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const b = neo4jBreaker(); // constructed with the mocked Date.now captured
      for (let i = 0; i < 5; i++) {
        await expect(b.exec(boom)).rejects.toThrow("down");
      }
      expect(b.getState()).toBe("open");

      // Advance well past the configured reset timeout, then probe.
      time += 60_000;
      await expect(b.exec(boom)).rejects.toThrow("down"); // probe fails → reopens
      await Promise.resolve();
      await Promise.resolve();

      // onTransition logs `[circuit-breaker] neo4j open->half-open ...` with no
      // ` err=` segment since the transition itself carries no error.
      const noErrLine = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("open->half-open"));
      expect(noErrLine).toBeDefined();
      expect(noErrLine).not.toContain(" err=");

      // The corresponding "[clickhouse emit failed]" line for that same
      // no-error transition must also omit ` err=`.
      const noErrEmitFailedLine = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .find(
          (line) =>
            line.includes("[clickhouse emit failed]") &&
            !line.includes(" err="),
        );
      expect(noErrEmitFailedLine).toBeDefined();
    } finally {
      dateSpy.mockRestore();
    }
  });
});
