import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertTokenUsage: vi.fn(),
  recordSpend: vi.fn(),
}));

vi.mock("@oxagen/telemetry", () => ({
  insertTokenUsage: mocks.insertTokenUsage,
}));
vi.mock("@oxagen/billing", () => ({ recordSpend: mocks.recordSpend }));

import { recordTokenUsage } from "./record-token-usage";

const row = {
  execution_step_id: "00000000-0000-4000-8000-00000000aaaa",
  org_id: "00000000-0000-4000-8000-000000000001",
  workspace_id: "00000000-0000-4000-8000-000000000002",
  model: "claude-sonnet-5",
  provider: "anthropic" as const,
  input_tokens: 100,
  output_tokens: 20,
  cached_tokens: 0,
  cache_write_tokens: 0,
  cost_usd_micros: 330,
  duration_ms: 12,
  surface: "api" as const,
  prompt_hash: "aabbccdd",
  created_at: "2026-09-14T10:00:00.000Z",
};

describe("recordTokenUsage", () => {
  beforeEach(() => {
    mocks.insertTokenUsage.mockReset().mockResolvedValue(undefined);
    mocks.recordSpend.mockReset().mockResolvedValue(undefined);
  });

  it("writes the frame and adds its micros to the org, workspace and day", async () => {
    await recordTokenUsage([row]);
    expect(mocks.insertTokenUsage).toHaveBeenCalledWith([row]);
    expect(mocks.recordSpend).toHaveBeenCalledWith({
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      at: new Date(row.created_at),
      micros: 330n,
    });
  });

  it("moves the counter when the frame store is down", async () => {
    mocks.insertTokenUsage.mockRejectedValueOnce(new Error("CH down"));
    await expect(recordTokenUsage([row])).resolves.toBeUndefined();
    expect(mocks.recordSpend).toHaveBeenCalledTimes(1);
  });

  it("keeps the frame when the counter write fails", async () => {
    mocks.recordSpend.mockRejectedValueOnce(new Error("PG down"));
    await expect(recordTokenUsage([row])).resolves.toBeUndefined();
    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
  });
});
