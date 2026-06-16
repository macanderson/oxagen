import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockInsertEvents } = vi.hoisted(() => ({
  mockInsertEvents: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mockInsertEvents }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

import { withTenantDb } from "@oxagen/database";
import { agentSubagentCancelHandler } from "./agent.subagent.cancel";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

type FanoutRow = { publicId: string; status: string };

// The handler issues up to three withTenantDb calls:
//   0: resolve fanout            select→from→where→limit
//   1: select non-terminal runs  select→from→where  (+ conditional update→set→where)
//   2: update fanout             update→set→where
function setup(fanoutRow: FanoutRow | null, nonTerminalRunIds: string[]) {
  let call = 0;
  const updateRunsSpy = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }));
  const updateFanoutSpy = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }));
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    if (typeof fn !== "function") return undefined as never;
    const c = call;
    call += 1;
    let tx: unknown;
    if (c === 0) {
      tx = {
        select: () => ({
          from: () => ({ where: () => ({ limit: () => Promise.resolve(fanoutRow ? [fanoutRow] : []) }) }),
        }),
      };
    } else if (c === 1) {
      tx = {
        select: () => ({
          from: () => ({ where: () => Promise.resolve(nonTerminalRunIds.map((id) => ({ publicId: id }))) }),
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
    mockInsertEvents.mockClear();
    mockInsertEvents.mockResolvedValue(undefined);
  });

  it("throws when the fanout does not exist", async () => {
    setup(null, []);
    await expect(
      agentSubagentCancelHandler({ fanoutId: "fan_missing" }, CTX),
    ).rejects.toThrow("Fanout fan_missing not found");
  });

  it("transitions non-terminal children, sets a terminal fanout status, and meters", async () => {
    const { updateRunsSpy, updateFanoutSpy } = setup({ publicId: "fan_1", status: "running" }, [
      "sar_1",
      "sar_2",
    ]);
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_1" }, CTX);

    expect(out.fanoutId).toBe("fan_1");
    expect(out.cancelledChildren).toBe(2);
    expect(out.status).toBe("timed_out"); // closest terminal status until a migration adds 'cancelled'
    expect(updateRunsSpy).toHaveBeenCalledTimes(1);
    expect(updateFanoutSpy).toHaveBeenCalledTimes(1);

    expect(mockInsertEvents).toHaveBeenCalledTimes(1);
    const rows = mockInsertEvents.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows[0]!.event_type).toBe("agent.subagent.cancel.ran");
    expect(rows[0]!.org_id).toBe("org_1");
  });

  it("does not update child runs when none are non-terminal", async () => {
    const { updateRunsSpy, updateFanoutSpy } = setup({ publicId: "fan_2", status: "running" }, []);
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_2" }, CTX);
    expect(out.cancelledChildren).toBe(0);
    expect(updateRunsSpy).not.toHaveBeenCalled();
    expect(updateFanoutSpy).toHaveBeenCalledTimes(1);
  });

  it("never fails the cancel when telemetry throws", async () => {
    mockInsertEvents.mockRejectedValueOnce(new Error("clickhouse down"));
    setup({ publicId: "fan_3", status: "running" }, ["sar_9"]);
    const out = await agentSubagentCancelHandler({ fanoutId: "fan_3" }, CTX);
    expect(out.cancelledChildren).toBe(1);
  });
});
