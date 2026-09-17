import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runListHandler: vi.fn() }));

vi.mock("./run.list", () => ({ runListHandler: mocks.runListHandler }));

import { runRecentListHandler } from "./run.recent.list";
import { makeCTX } from "./test-utils/fixtures";

const row = {
  id: "arun_0123456789abcdef012345",
  source: "ledger",
  agentKey: "acme.core.reviewer",
  operatorId: null,
  status: "sealed",
  turns: 1,
  steps: 3,
  frames: 4,
  cost: null,
  taskRef: "explain",
  startedAt: "2026-09-14T10:00:00.000Z",
  sealedAt: "2026-09-14T10:00:09.000Z",
};

describe("list_recent_runs", () => {
  it("reads one page of list_runs at the asked size and keeps the menu's four fields", async () => {
    const ctx = makeCTX();
    mocks.runListHandler.mockResolvedValue({
      runs: [row, { ...row, id: "tse_4q8r1t6v3x5z0b2d7h2k9m", agentKey: null }],
      nextCursor: "abc",
    });
    const out = await runRecentListHandler({ limit: 5 }, ctx);
    expect(mocks.runListHandler).toHaveBeenCalledWith({ limit: 5 }, ctx);
    expect(out).toEqual({
      runs: [
        {
          id: row.id,
          agentKey: "acme.core.reviewer",
          status: "sealed",
          startedAt: row.startedAt,
        },
        {
          id: "tse_4q8r1t6v3x5z0b2d7h2k9m",
          agentKey: null,
          status: "sealed",
          startedAt: row.startedAt,
        },
      ],
    });
  });
});
