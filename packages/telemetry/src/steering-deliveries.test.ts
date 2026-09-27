import { beforeEach, describe, expect, it, vi } from "vitest";
const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./tenant", () => ({ chSelect: select }));
import { selectSteeringDeliveries } from "./steering-deliveries";
const row = (over: Record<string, unknown> = {}) => ({
  session_uuid: "10000000-0000-4000-8000-000000000001",
  sealed_at: "2026-09-22 12:00:00.000",
  harness: "codex",
  agent_key: "review",
  included_ids: ["present"],
  cut_ids: ["missing"],
  cut_reasons: ["budget"],
  budget_tokens: "4096",
  spent_tokens: "3200",
  ...over,
});
const args = {
  fromMs: Date.parse("2026-09-15T00:00:00Z"),
  toMs: Date.parse("2026-09-22T00:00:00Z"),
  limit: 50,
};
beforeEach(() => select.mockReset());
describe("steering delivery counts", () => {
  it("counts included records and budget cuts in the bounded tenant query", async () => {
    select.mockResolvedValue({ data: [row()] });
    const out = await selectSteeringDeliveries(args);
    expect(out).toEqual({
      scanned: 1,
      truncated: false,
      runs: [
        {
          sessionUuid: "10000000-0000-4000-8000-000000000001",
          ts: "2026-09-22 12:00:00.000",
          harness: "codex",
          agentKey: "review",
          recordsIncluded: 1,
          recordsCut: 1,
          recordsCutForBudget: 1,
          budgetTokens: 4096,
          spentTokens: 3200,
        },
      ],
      undelivered: [
        {
          recordId: "missing",
          runs: 1,
          lastReason: "budget",
          lastSeen: "2026-09-22 12:00:00.000",
        },
      ],
    });
    expect(select).toHaveBeenCalledWith({
      query: expect.stringContaining("org_id = {orgId:UUID}"),
      params: {
        since: "2026-09-15 00:00:00.000",
        until: "2026-09-22 00:00:00.000",
        scan: 2001,
      },
    });
    const query = select.mock.calls[0]![0].query;
    expect(query).toContain("workspace_id = {workspaceId:UUID}");
    expect(query).toContain("chain_verified = 1");
    expect(query).toContain("argMax(body, seq)");
    // The table partitions by the month of received_at (#4297): the window's
    // lower bound on it keeps the read to the months around the window, a
    // day wide for a host clock that runs ahead, with no upper bound for a
    // manifest shipped late.
    expect(
      query.match(/received_at[^\n]*/g)?.map((line: string) => line.trim()),
    ).toEqual(["received_at >= {since:DateTime64(3)} - INTERVAL 1 DAY"]);
  });
  it("excludes any included record and counts a cut record once per run", async () => {
    select.mockResolvedValue({
      data: [
        row({
          cut_ids: ["missing", "missing", "present", "older"],
          cut_reasons: ["tier", "tier", "budget"],
          sealed_at: "2026-09-20 00:00:00.000",
        }),
        row({
          cut_ids: ["missing", "alpha"],
          cut_reasons: ["budget", "superseded"],
        }),
      ],
    });
    const out = await selectSteeringDeliveries(args);
    expect(out.undelivered).toEqual([
      {
        recordId: "missing",
        runs: 2,
        lastReason: "budget",
        lastSeen: "2026-09-22 12:00:00.000",
      },
      {
        recordId: "alpha",
        runs: 1,
        lastReason: "superseded",
        lastSeen: "2026-09-22 12:00:00.000",
      },
      {
        recordId: "older",
        runs: 1,
        lastReason: "",
        lastSeen: "2026-09-20 00:00:00.000",
      },
    ]);
  });
  it("reports truncation and excludes the probe row from counts", async () => {
    select.mockResolvedValue({
      data: [
        ...Array.from({ length: 2000 }, () => row()),
        row({ included_ids: ["missing"] }),
      ],
    });
    const out = await selectSteeringDeliveries({ ...args, limit: 1 });
    expect(out.scanned).toBe(2000);
    expect(out.truncated).toBe(true);
    expect(out.runs).toHaveLength(1);
    expect(out.undelivered[0]?.runs).toBe(2000);
  });
  it("returns an empty sample and preserves a failed read", async () => {
    select.mockResolvedValueOnce({ data: [] });
    expect(await selectSteeringDeliveries(args)).toEqual({
      runs: [],
      undelivered: [],
      scanned: 0,
      truncated: false,
    });
    select.mockRejectedValueOnce(new Error("unavailable"));
    await expect(selectSteeringDeliveries(args)).rejects.toThrow("unavailable");
  });
});
