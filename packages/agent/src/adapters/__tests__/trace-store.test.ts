/**
 * Unit tests for createClickHouseTraceStore.
 *
 * insertEvents is mocked to avoid live ClickHouse calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

const { insertEvents } = vi.hoisted(() => ({
  insertEvents: vi.fn(),
}));

vi.mock("@oxagen/telemetry", () => ({
  insertEvents,
}));

// Capture the module's pino logger so we can assert the drop path is logged.
const { pinoLogger } = vi.hoisted(() => ({
  pinoLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("pino", () => ({ default: () => pinoLogger }));

import { createClickHouseTraceStore } from "../trace-store";

// ── tests ─────────────────────────────────────────────────────────────────────

const ARGS = { orgId: "org-1", workspaceId: "ws-1", surface: "agent" };

beforeEach(() => {
  insertEvents.mockReset();
  insertEvents.mockResolvedValue(undefined);
  pinoLogger.warn.mockReset();
});

describe("createClickHouseTraceStore — record", () => {
  it("calls insertEvents with correct org_id and workspace_id", async () => {
    const store = createClickHouseTraceStore(ARGS);

    store.record({
      instruction: "fix the tests",
      changedFiles: ["a.ts", "b.ts"],
      steps: 5,
      text: "done",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // insertEvents is fire-and-forget — wait one microtask for the void promise to settle
    await Promise.resolve();

    expect(insertEvents).toHaveBeenCalledOnce();
    const [rows] = insertEvents.mock.calls[0] as [unknown[]];
    expect(rows).toHaveLength(1);
    const row = rows[0] as {
      org_id: string;
      workspace_id: string;
      event_type: string;
      source_system: string;
      payload: string;
    };
    expect(row.org_id).toBe("org-1");
    expect(row.workspace_id).toBe("ws-1");
    expect(row.event_type).toBe("agent.coding.turn");
    expect(row.source_system).toBe("agent");

    const payload = JSON.parse(row.payload) as {
      changedFilesCount: number;
      stepsCount: number;
    };
    expect(payload.changedFilesCount).toBe(2);
    expect(payload.stepsCount).toBe(5);
  });

  it("is fire-and-forget — does not throw when insertEvents rejects", async () => {
    insertEvents.mockRejectedValueOnce(new Error("ClickHouse down"));

    const store = createClickHouseTraceStore(ARGS);

    // record() must not throw synchronously or return a rejected Promise
    expect(() =>
      store.record({ instruction: "x", changedFiles: [], steps: 1 }),
    ).not.toThrow();

    // Wait for the rejected promise to be swallowed
    await Promise.resolve();
  });

  it("logs a warning (turn event dropped) when insertEvents rejects — failure is observable, not silent", async () => {
    insertEvents.mockRejectedValueOnce(new Error("ClickHouse down"));

    const store = createClickHouseTraceStore(ARGS);
    expect(() =>
      store.record({ instruction: "x", changedFiles: [], steps: 1 }),
    ).not.toThrow();

    // Let the rejected void promise settle so the .catch handler runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(pinoLogger.warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = pinoLogger.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx.orgId).toBe("org-1");
    expect(msg).toContain("insertEvents failed");
  });

  it("handles undefined / partial trace gracefully", async () => {
    insertEvents.mockResolvedValue(undefined);
    const store = createClickHouseTraceStore(ARGS);

    expect(() => store.record(undefined)).not.toThrow();
    expect(() => store.record({})).not.toThrow();

    await Promise.resolve();
    expect(insertEvents).toHaveBeenCalledTimes(2);
  });
});
