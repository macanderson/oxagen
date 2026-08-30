import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  tenantDbFindFirst: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: {
          workspaceBudgetPolicy: { findFirst: mocks.tenantDbFindFirst },
        },
      }),
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { workspaceBudgetPolicyReadHandler } from "./workspace.budget_policy.read";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

describe("workspaceBudgetPolicyReadHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.tenantDbFindFirst.mockReset();
  });

  it("throws when workspaceId is null", async () => {
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });
    await expect(workspaceBudgetPolicyReadHandler({}, noWsCtx)).rejects.toThrow(
      "workspace.budget.policy.read requires a workspace context",
    );
  });

  it("returns the off-by-default policy when no policy row exists", async () => {
    mocks.tenantDbFindFirst.mockResolvedValue(undefined);
    const result = await workspaceBudgetPolicyReadHandler({}, TEST_CTX);
    expect(result).toEqual({
      enabled: false,
      limitUsd: null,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });
  });

  it("returns the stored policy", async () => {
    mocks.tenantDbFindFirst.mockResolvedValue({
      enabled: true,
      limitUsd: 5.0,
      mode: "grace",
      graceOveragePct: 0.5,
      enforcement: "default",
    });
    const result = await workspaceBudgetPolicyReadHandler({}, TEST_CTX);
    expect(result).toEqual({
      enabled: true,
      limitUsd: 5.0,
      mode: "grace",
      graceOveragePct: 0.5,
      enforcement: "default",
    });
  });

  it("normalizes an unexpected stored mode to 'enforce'", async () => {
    mocks.tenantDbFindFirst.mockResolvedValue({
      enabled: true,
      limitUsd: 2.5,
      mode: "garbage",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });
    const result = await workspaceBudgetPolicyReadHandler({}, TEST_CTX);
    expect(result.mode).toBe("enforce");
  });

  it("normalizes an unexpected stored enforcement to 'ceiling'", async () => {
    mocks.tenantDbFindFirst.mockResolvedValue({
      enabled: true,
      limitUsd: 2.5,
      mode: "prompt",
      graceOveragePct: 0.25,
      enforcement: "bad_value",
    });
    const result = await workspaceBudgetPolicyReadHandler({}, TEST_CTX);
    expect(result.enforcement).toBe("ceiling");
  });

  it("normalizes 'default' enforcement correctly", async () => {
    mocks.tenantDbFindFirst.mockResolvedValue({
      enabled: true,
      limitUsd: 3.0,
      mode: "prompt",
      graceOveragePct: 0.25,
      enforcement: "default",
    });
    const result = await workspaceBudgetPolicyReadHandler({}, TEST_CTX);
    expect(result.enforcement).toBe("default");
  });

  it("coerces null limitUsd to null in output", async () => {
    mocks.tenantDbFindFirst.mockResolvedValue({
      enabled: false,
      limitUsd: null,
      mode: "enforce",
      graceOveragePct: 0.25,
      enforcement: "ceiling",
    });
    const result = await workspaceBudgetPolicyReadHandler({}, TEST_CTX);
    expect(result.limitUsd).toBeNull();
  });
});
