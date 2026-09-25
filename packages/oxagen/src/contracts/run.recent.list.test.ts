import { describe, expect, it } from "vitest";
import {
  RECENT_RUNS_MAX,
  recentRunSchema,
  runRecentList,
} from "./run.recent.list";

const run = {
  id: "arun_0123456789abcdef012345",
  agentKey: "acme.core.reviewer",
  status: "sealed",
  startedAt: "2026-09-14T10:00:00.000Z",
};

describe("list_recent_runs contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped", () => {
    expect(runRecentList.mutates).toBe(false);
    expect(runRecentList.noBillingGate).toBe(true);
    expect(runRecentList.scoped).toBe(true);
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(runRecentList.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(runRecentList.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "run",
    });
  });

  it("defaults to eight rows and refuses a limit past ten or an unknown key", () => {
    expect(runRecentList.input.parse({})).toEqual({ limit: 8 });
    expect(
      runRecentList.input.safeParse({ limit: RECENT_RUNS_MAX + 1 }).success,
    ).toBe(false);
    expect(runRecentList.input.safeParse({ cursor: "x" }).success).toBe(false);
  });

  it("rows carry the menu's four fields with a nullable agent key", () => {
    expect(recentRunSchema.parse(run)).toEqual(run);
    expect(
      recentRunSchema.parse({ ...run, agentKey: null }).agentKey,
    ).toBeNull();
    expect(recentRunSchema.safeParse({ ...run, id: "run_1" }).success).toBe(
      false,
    );
    expect(recentRunSchema.safeParse({ ...run, cost: null }).success).toBe(
      false,
    );
  });
});
