import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireScope, runInTenantScope } from "@oxagen/tenancy";
const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  finalize: vi.fn(),
  stamp: vi.fn(),
}));
vi.mock("@oxagen/billing", () => ({
  admitUsage: mocks.admit,
  finalizeUsage: mocks.finalize,
}));
vi.mock("@oxagen/telemetry", () => ({ stampTokenUsage: mocks.stamp }));
import { admitTokenUsage, recordTokenUsage } from "./record-token-usage";
const row = {
  execution_step_id: null,
  org_id: "00000000-0000-4000-8000-000000000001",
  workspace_id: "00000000-0000-4000-8000-000000000002",
  model: "claude-sonnet-5",
  provider: "anthropic" as const,
  input_tokens: 100,
  output_tokens: 20,
  cached_tokens: 0,
  cost_usd_micros: 330,
  duration_ms: 12,
  surface: "api" as const,
  prompt_hash: "aabb",
  created_at: "2026-09-14T10:00:00.000Z",
};
beforeEach(() => {
  mocks.admit.mockReset().mockResolvedValue("call-id");
  mocks.finalize.mockReset().mockResolvedValue(undefined);
  mocks.stamp
    .mockReset()
    .mockImplementation((rows) =>
      rows.map((r: object) => ({ ...r, trace_id: "captured-trace" })),
    );
});
describe("durable usage boundary", () => {
  it("admits with explicit tenant scope before a provider can run", async () => {
    mocks.admit.mockImplementation(async () => {
      expect(requireScope()).toMatchObject({
        orgId: row.org_id,
        workspaceId: row.workspace_id,
      });
      return "call-id";
    });
    await expect(admitTokenUsage(row.org_id, row.workspace_id)).resolves.toBe(
      "call-id",
    );
  });
  it("propagates admission refusal", async () => {
    mocks.admit.mockRejectedValue(new Error("database unavailable"));
    await expect(admitTokenUsage(row.org_id, row.workspace_id)).rejects.toThrow(
      "database unavailable",
    );
  });
  it("captures attribution before queuing and preserves scope", async () => {
    mocks.finalize.mockImplementation(async () => {
      expect(requireScope().principalId).toBe(
        "00000000-0000-4000-8000-000000000003",
      );
    });
    await runInTenantScope(
      {
        orgId: row.org_id,
        workspaceId: row.workspace_id,
        principalId: "00000000-0000-4000-8000-000000000003",
      },
      () => recordTokenUsage("call-id", row, undefined, false),
    );
    expect(mocks.finalize).toHaveBeenCalledWith({
      id: "call-id",
      row: { ...row, trace_id: "captured-trace" },
      charge: undefined,
      complete: false,
    });
  });
  it("does not hide settlement failure", async () => {
    mocks.finalize.mockRejectedValue(new Error("settlement failed"));
    await expect(recordTokenUsage("call-id", row)).rejects.toThrow(
      "settlement failed",
    );
  });
});
