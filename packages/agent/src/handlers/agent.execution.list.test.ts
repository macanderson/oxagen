import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});

import { withTenantDb } from "@oxagen/database";
import { agentExecutionListHandler } from "./agent.execution.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

interface Row {
  publicId: string;
  agentId: string | null;
  originType: string;
  originId: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  createdAt: Date;
}

function row(i: number): Row {
  return {
    publicId: `aex_${i}`,
    agentId: null,
    originType: "chat",
    originId: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    startedAt: new Date(`2026-06-16T00:0${i}:00Z`),
    completedAt: new Date(`2026-06-16T00:0${i}:04Z`),
    latencyMs: 4000,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: "0.012000",
    createdAt: new Date(`2026-06-16T00:0${i}:00Z`),
  };
}

// The handler issues one withTenantDb: select→from→where→orderBy→limit.
function setup(rows: Row[]) {
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    if (typeof fn !== "function") return undefined as never;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(rows) }),
          }),
        }),
      }),
    };
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  });
}

describe("agent.execution.list handler", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  it("returns rows newest-first with null nextCursor when under the limit", async () => {
    setup([row(3), row(2), row(1)]);
    const out = await agentExecutionListHandler({ limit: 25 }, CTX);
    expect(out.executions).toHaveLength(3);
    expect(out.executions[0]?.executionId).toBe("aex_3");
    expect(out.executions[0]?.estimatedCostUsd).toBe("0.012000");
    expect(out.nextCursor).toBeNull();
  });

  it("computes nextCursor and trims the over-fetched row when a page is full", async () => {
    // limit 2 → handler fetches 3; the extra row signals another page exists.
    setup([row(3), row(2), row(1)]);
    const out = await agentExecutionListHandler({ limit: 2 }, CTX);
    expect(out.executions).toHaveLength(2);
    expect(out.executions.map((e) => e.executionId)).toEqual([
      "aex_3",
      "aex_2",
    ]);
    // Cursor is the createdAt of the LAST returned row (aex_2), not the dropped one.
    expect(out.nextCursor).toBe(row(2).createdAt.toISOString());
  });

  it("returns an empty page with null cursor", async () => {
    setup([]);
    const out = await agentExecutionListHandler({ limit: 25 }, CTX);
    expect(out.executions).toEqual([]);
    expect(out.nextCursor).toBeNull();
  });
});
