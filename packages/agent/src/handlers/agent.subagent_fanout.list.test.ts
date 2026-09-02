import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

import { withTenantDb } from "@oxagen/database";
import { agentSubagentFanoutListHandler } from "./agent.subagent_fanout.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

type FanoutRow = {
  publicId: string;
  parentMessageId: string;
  status: string;
  totalChildren: number;
  completedChildren: number;
  createdAt: Date;
  updatedAt: Date;
};

const whereSpy = vi.fn();
const limitSpy = vi.fn();

// Capture the where() argument so we can assert the parentMessageId filter is
// (or is not) applied, while returning the supplied rows from limit().
function setupRows(rows: FanoutRow[]) {
  whereSpy.mockClear();
  limitSpy.mockClear();
  limitSpy.mockResolvedValue(rows);
  vi.mocked(withTenantDb).mockImplementation(async (fn) =>
    fn({
      select: () => ({
        from: () => ({
          where: (...args: unknown[]) => {
            whereSpy(...args);
            return { orderBy: () => ({ limit: limitSpy }) };
          },
        }),
      }),
    } as unknown as Parameters<typeof fn>[0]),
  );
}

function row(overrides: Partial<FanoutRow> = {}): FanoutRow {
  return {
    publicId: "fan_1",
    parentMessageId: "msg_1",
    status: "running",
    totalChildren: 3,
    completedChildren: 1,
    createdAt: new Date("2026-06-16T00:00:00Z"),
    updatedAt: new Date("2026-06-16T00:01:00Z"),
    ...overrides,
  };
}

describe("agent.subagent.fanout.list handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps rows to the contract shape with ISO timestamps", async () => {
    setupRows([row()]);
    const out = await agentSubagentFanoutListHandler({ limit: 50 }, CTX);
    expect(out.fanouts).toHaveLength(1);
    expect(out.fanouts[0]).toMatchObject({
      fanoutId: "fan_1",
      parentMessageId: "msg_1",
      status: "running",
      totalChildren: 3,
      completedChildren: 1,
    });
    expect(out.fanouts[0]?.createdAt).toBe("2026-06-16T00:00:00.000Z");
    expect(out.fanouts[0]?.updatedAt).toBe("2026-06-16T00:01:00.000Z");
  });

  it("returns an empty list when there are no fan-outs", async () => {
    setupRows([]);
    const out = await agentSubagentFanoutListHandler({ limit: 50 }, CTX);
    expect(out.fanouts).toEqual([]);
  });

  it("passes the limit through to the query", async () => {
    setupRows([]);
    await agentSubagentFanoutListHandler({ limit: 5 }, CTX);
    expect(limitSpy).toHaveBeenCalledWith(5);
  });

  it("defaults limit to 50 when undefined", async () => {
    setupRows([]);
    // The contract defaults limit at parse time; the handler also guards with
    // `?? 50` so a runtime-undefined limit still falls back safely.
    await agentSubagentFanoutListHandler(
      { limit: undefined } as unknown as Parameters<
        typeof agentSubagentFanoutListHandler
      >[0],
      CTX,
    );
    expect(limitSpy).toHaveBeenCalledWith(50);
  });
});
