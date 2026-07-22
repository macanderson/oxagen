import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockInsertEvents, mockProjectSubagentFanoutLineage } = vi.hoisted(
  () => ({
    mockInsertEvents: vi.fn(async (..._args: unknown[]) => undefined),
    mockProjectSubagentFanoutLineage: vi.fn(
      async (..._args: unknown[]) => undefined,
    ),
  }),
);
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mockInsertEvents }));

// The lineage graph projection (issue #1078) is exercised end-to-end by its
// own dedicated tests (packages/agent/src/dispatch/lineage-projection.test.ts).
// Here we only need to prove the cancel handler calls it with the right
// scope/id and never lets it fail the cancel.
vi.mock("../dispatch/lineage-projection", () => ({
  projectSubagentFanoutLineage: mockProjectSubagentFanoutLineage,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

// Capture every eq() invocation so tests can assert which column/value pairs the
// handler builds — in particular that the child-runs query keys subagentRuns.fanoutId
// on the resolved internal uuid (fanout.id), not the public fanout id.
const { eqCalls } = vi.hoisted(() => ({
  eqCalls: [] as Array<[unknown, unknown]>,
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (col: unknown, val: unknown) => {
      eqCalls.push([col, val]);
      return real.eq(col as never, val as never);
    },
  };
});

import { withTenantDb, schema } from "@oxagen/database";
import { agentSubagentCancelHandler } from "./agent.subagent.cancel";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

type FanoutRow = { id: string; publicId: string; status: string };

// The handler issues up to three withTenantDb calls:
//   0: resolve fanout            select→from→where→limit
//   1: select non-terminal runs  select→from→where  (+ conditional update→set→where)
//   2: update fanout             update→set→where
function setup(fanoutRow: FanoutRow | null, nonTerminalRunIds: string[]) {
  let call = 0;
  const updateRunsSpy = vi.fn(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }));
  const updateFanoutSpy = vi.fn(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }));
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    if (typeof fn !== "function") return undefined as never;
    const c = call;
    call += 1;
    let tx: unknown;
    if (c === 0) {
      tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(fanoutRow ? [fanoutRow] : []),
            }),
          }),
        }),
      };
    } else if (c === 1) {
      tx = {
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve(
                nonTerminalRunIds.map((id) => ({ publicId: id })),
              ),
          }),
        }),
        update: updateRunsSpy,
      };
    } else {
      tx = { update: updateFanoutSpy };
    }
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  });
  return { updateRunsSpy, updateFanoutSpy };
}

describe("agent.subagent.cancel handler", () => {
  beforeEach(() => {
    vi.mocked(withTenantDb).mockReset();
    eqCalls.length = 0;
    mockInsertEvents.mockClear();
    mockInsertEvents.mockResolvedValue(undefined);
    mockProjectSubagentFanoutLineage.mockClear();
    mockProjectSubagentFanoutLineage.mockResolvedValue(undefined);
  });

  it("throws when the fanout does not exist", async () => {
    setup(null, []);
    await expect(
      agentSubagentCancelHandler({ fanoutId: "fan_missing" }, CTX),
    ).rejects.toThrow("Fanout fan_missing not found");
  });

  it("transitions non-terminal children, sets a terminal fanout status, and meters", async () => {
    const { updateRunsSpy, updateFanoutSpy } = setup(
      { id: "fan_uuid_1", publicId: "fan_1", status: "running" },
      ["sar_1", "sar_2"],
    );
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_1" }, CTX);

    expect(out.fanoutId).toBe("fan_1");
    expect(out.cancelledChildren).toBe(2);
    expect(out.status).toBe("timed_out"); // closest terminal status until a migration adds 'cancelled'
    expect(updateRunsSpy).toHaveBeenCalledTimes(1);
    expect(updateFanoutSpy).toHaveBeenCalledTimes(1);

    // Regression: the child-runs query must key subagentRuns.fanoutId on the
    // resolved internal uuid (fanout.id), NOT the public id passed by the caller.
    const runsFanoutEq = eqCalls.find(
      ([col]) => col === schema.subagentRuns.fanoutId,
    );
    expect(runsFanoutEq).toBeDefined();
    expect(runsFanoutEq![1]).toBe("fan_uuid_1");
    expect(runsFanoutEq![1]).not.toBe("fan_1");

    expect(mockInsertEvents).toHaveBeenCalledTimes(1);
    const rows = mockInsertEvents.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]!.event_type).toBe("agent.subagent.cancel.ran");
    expect(rows[0]!.org_id).toBe("org_1");

    // Fleet lineage graph projection (issue #1078): projected after a
    // successful cancel, keyed on the resolved internal fanout uuid (NOT the
    // public id), scoped to the calling org/workspace.
    expect(mockProjectSubagentFanoutLineage).toHaveBeenCalledTimes(1);
    expect(mockProjectSubagentFanoutLineage).toHaveBeenCalledWith({
      fanoutId: "fan_uuid_1",
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
  });

  it("does not update child runs when none are non-terminal", async () => {
    const { updateRunsSpy, updateFanoutSpy } = setup(
      { id: "fan_uuid_2", publicId: "fan_2", status: "running" },
      [],
    );
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_2" }, CTX);
    expect(out.cancelledChildren).toBe(0);
    expect(updateRunsSpy).not.toHaveBeenCalled();
    expect(updateFanoutSpy).toHaveBeenCalledTimes(1);
  });

  it("never fails the cancel when telemetry throws", async () => {
    mockInsertEvents.mockRejectedValueOnce(new Error("clickhouse down"));
    setup({ id: "fan_uuid_3", publicId: "fan_3", status: "running" }, [
      "sar_9",
    ]);
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_3" }, CTX);
    expect(out.cancelledChildren).toBe(1);
  });

  it("never fails the cancel when the lineage graph projection throws (best-effort, non-blocking)", async () => {
    mockProjectSubagentFanoutLineage.mockRejectedValueOnce(
      new Error("neo4j unavailable"),
    );
    setup({ id: "fan_uuid_4", publicId: "fan_4", status: "running" }, [
      "sar_10",
    ]);
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_4" }, CTX);
    expect(out.cancelledChildren).toBe(1);
    expect(out.status).toBe("timed_out");
    expect(mockProjectSubagentFanoutLineage).toHaveBeenCalledTimes(1);
  });
});
