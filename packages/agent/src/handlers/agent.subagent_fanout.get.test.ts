import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

import { withTenantDb } from "@oxagen/database";
import { agentSubagentFanoutGetHandler } from "./agent.subagent_fanout.get";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

type FanoutRow = {
  id: string;
  publicId: string;
  parentMessageId: string;
  status: string;
  totalChildren: number;
  completedChildren: number;
  createdAt: Date;
  updatedAt: Date;
};
type RunRow = {
  publicId: string;
  capabilityName: string;
  status: string;
  errorReason: string | null;
  inputPayload: unknown;
  outputPayload: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
};

// The handler issues up to two withTenantDb calls: first resolves the fanout
// (select→from→where→limit), second resolves the runs (select→from→where→
// orderBy). The throw path makes only the first call. mockReset in beforeEach
// clears any leftover queued impls so call N+1 never leaks into the next test.
function setup(fanoutRow: FanoutRow | null, runs: RunRow[]) {
  let call = 0;
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    // Defensive: tolerate any non-callback invocation so the chained tx mock
    // never throws "fn is not a function" on a stray call.
    if (typeof fn !== "function") return undefined as never;
    const isFirst = call === 0;
    call += 1;
    const tx = isFirst
      ? {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve(fanoutRow ? [fanoutRow] : []),
              }),
            }),
          }),
        }
      : {
          select: () => ({
            from: () => ({
              where: () => ({ orderBy: () => Promise.resolve(runs) }),
            }),
          }),
        };
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  });
}

function fanout(overrides: Partial<FanoutRow> = {}): FanoutRow {
  return {
    id: "fanuuid_1",
    publicId: "fan_1",
    parentMessageId: "msg_1",
    status: "partial",
    totalChildren: 2,
    completedChildren: 1,
    createdAt: new Date("2026-06-16T00:00:00Z"),
    updatedAt: new Date("2026-06-16T00:01:00Z"),
    ...overrides,
  };
}

describe("agent.subagent.fanout.get handler", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  it("throws when the fanout does not exist", async () => {
    setup(null, []);
    await expect(
      agentSubagentFanoutGetHandler({ fanoutId: "fan_missing" }, CTX),
    ).rejects.toThrow("Fanout fan_missing not found");
  });

  it("computes durationMs, byte sizes, and output preview", async () => {
    setup(fanout(), [
      {
        publicId: "sar_1",
        capabilityName: "list_agent_tools",
        status: "completed",
        errorReason: null,
        inputPayload: { q: "x" },
        outputPayload: { tools: ["a", "b"] },
        startedAt: new Date("2026-06-16T00:00:01Z"),
        completedAt: new Date("2026-06-16T00:00:03Z"),
      },
    ]);
    const out = await agentSubagentFanoutGetHandler({ fanoutId: "fan_1" }, CTX);
    expect(out.fanoutId).toBe("fan_1");
    expect(out.status).toBe("partial");
    expect(out.runs).toHaveLength(1);
    const r = out.runs[0]!;
    expect(r.durationMs).toBe(2000);
    expect(r.inputBytes).toBeGreaterThan(0);
    expect(r.outputBytes).toBeGreaterThan(0);
    expect(r.outputPreview).toContain("tools");
  });

  it("nulls timings/preview for a pending run with no output", async () => {
    setup(fanout(), [
      {
        publicId: "sar_2",
        capabilityName: "recall_memory",
        status: "pending",
        errorReason: null,
        inputPayload: {},
        outputPayload: null,
        startedAt: null,
        completedAt: null,
      },
    ]);
    const out = await agentSubagentFanoutGetHandler({ fanoutId: "fan_1" }, CTX);
    const r = out.runs[0]!;
    expect(r.durationMs).toBeNull();
    expect(r.startedAt).toBeNull();
    expect(r.completedAt).toBeNull();
    expect(r.outputBytes).toBe(0);
    expect(r.outputPreview).toBeNull();
  });

  it("truncates an oversized output preview", async () => {
    const big = { data: "x".repeat(2000) };
    setup(fanout(), [
      {
        publicId: "sar_3",
        capabilityName: "x",
        status: "completed",
        errorReason: null,
        inputPayload: {},
        outputPayload: big,
        startedAt: new Date("2026-06-16T00:00:01Z"),
        completedAt: new Date("2026-06-16T00:00:02Z"),
      },
    ]);
    const out = await agentSubagentFanoutGetHandler({ fanoutId: "fan_1" }, CTX);
    const r = out.runs[0]!;
    expect(r.outputPreview?.endsWith("…")).toBe(true);
    expect(r.outputPreview!.length).toBeLessThanOrEqual(501);
  });

  it("surfaces the error reason from a failed run", async () => {
    setup(fanout({ status: "partial" }), [
      {
        publicId: "sar_4",
        capabilityName: "x",
        status: "failed",
        errorReason: "boom",
        inputPayload: {},
        outputPayload: null,
        startedAt: new Date("2026-06-16T00:00:01Z"),
        completedAt: new Date("2026-06-16T00:00:02Z"),
      },
    ]);
    const out = await agentSubagentFanoutGetHandler({ fanoutId: "fan_1" }, CTX);
    expect(out.runs[0]?.status).toBe("failed");
    expect(out.runs[0]?.errorReason).toBe("boom");
  });
});
