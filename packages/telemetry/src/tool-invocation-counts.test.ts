import { beforeEach, describe, expect, it, vi } from "vitest";

const chSelect = vi.fn(
  async (_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as Array<{ capability_name: string; calls: string }>,
  }),
);
vi.mock("./tenant", () => ({
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import {
  countRecentToolInvocations,
  TOOL_INVOCATION_WINDOW_DAYS,
} from "./tool-invocation-counts";

beforeEach(() => {
  chSelect.mockClear();
});

describe("countRecentToolInvocations", () => {
  it("asks nothing for an empty page", async () => {
    expect(await countRecentToolInvocations([])).toEqual(new Map());
    expect(chSelect).not.toHaveBeenCalled();
  });

  it("counts by capability id over the 30-day window, scoped to the tenant", async () => {
    chSelect.mockResolvedValueOnce({
      data: [{ capability_name: "mcp.srv.search", calls: "12" }],
    });
    const counts = await countRecentToolInvocations([
      "mcp.srv.search",
      "list_runs",
    ]);
    expect(counts).toEqual(new Map([["mcp.srv.search", 12]]));
    const q = chSelect.mock.calls[0]![0];
    expect(q.query).toMatch(/org_id = \{orgId:UUID\}/);
    expect(q.query).toMatch(/workspace_id = \{workspaceId:UUID\}/);
    expect(q.query).toMatch(/GROUP BY capability_name/);
    expect(q.params).toEqual({
      capabilityIds: ["mcp.srv.search", "list_runs"],
      windowDays: TOOL_INVOCATION_WINDOW_DAYS,
    });
    expect(TOOL_INVOCATION_WINDOW_DAYS).toBe(30);
  });
});
