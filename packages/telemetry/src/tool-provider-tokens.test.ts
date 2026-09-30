import { beforeEach, describe, expect, it, vi } from "vitest";
const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./tenant", () => ({ chSelect: select }));
import { selectToolProviderTokens } from "./tool-provider-tokens";

const args = {
  fromMs: Date.parse("2026-09-20T00:00:00Z"),
  toMs: Date.parse("2026-09-27T00:00:00Z"),
};
beforeEach(() => {
  select.mockReset();
});

describe("tool provider tokens (#4537)", () => {
  it("reads each provider's newest listed tokens over the window in one tenant query", async () => {
    select.mockResolvedValue({
      data: [
        {
          tool_provider: "github",
          tokens: "5200",
          listed_at: "2026-09-26 12:00:00.000",
        },
        {
          tool_provider: "builtin",
          tokens: 9100,
          listed_at: "2026-09-26 11:00:00.000",
        },
      ],
    });
    await expect(selectToolProviderTokens(args)).resolves.toEqual([
      { provider: "github", tokens: 5200, listedAt: "2026-09-26 12:00:00.000" },
      { provider: "builtin", tokens: 9100, listedAt: "2026-09-26 11:00:00.000" },
    ]);
    expect(select).toHaveBeenCalledWith({
      query: expect.stringContaining("org_id = {orgId:UUID}"),
      params: {
        since: "2026-09-20 00:00:00.000",
        until: "2026-09-27 00:00:00.000",
        scan: 1000,
      },
    });
    const query: string = select.mock.calls[0]![0].query;
    expect(query).toContain("JSONExtractString(p, 'kind') = 'tool'");
    // The alias does not shadow the table's own `provider` column.
    expect(query).toContain("AS tool_provider");
    expect(query).toContain("GROUP BY session_uuid, seq, tool_provider");
    expect(query).toContain("LIMIT 1 BY tool_provider");
    expect(query).toContain(
      "received_at >= {since:DateTime64(3)} - INTERVAL 1 DAY",
    );
  });

  it("drops a part that names no provider, and reads nothing as no providers (negative)", async () => {
    select.mockResolvedValue({
      data: [
        { tool_provider: "", tokens: "40", listed_at: "2026-09-26 12:00:00.000" },
      ],
    });
    await expect(selectToolProviderTokens(args)).resolves.toEqual([]);
    select.mockResolvedValue({ data: [] });
    await expect(selectToolProviderTokens(args)).resolves.toEqual([]);
  });
});
