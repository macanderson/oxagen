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
    const rows = insertEvents.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    const row = rows[0]!;
    expect(row).toMatchObject({
      event_type: "circuit_breaker.open",
      source_system: "circuit-breaker",
      org_id: "00000000-0000-0000-0000-000000000000",
      workspace_id: "00000000-0000-0000-0000-000000000000",
    });
    const payload = JSON.parse(row.payload as string);
    expect(payload).toMatchObject({ key: "neo4j", to: "open", failureCount: 5 });
  });
});
