import { describe, expect, it } from "vitest";
import { COMMAND_REASON_MAX } from "../tacho/command-limits";
import { pauseWorkspaceRuns } from "./tacho.workspace_runs.pause";

describe("pause_workspace_runs contract", () => {
  it("is a high-risk control write the in-app agent must ask a person for", () => {
    expect(pauseWorkspaceRuns.mutates).toBe(true);
    expect(pauseWorkspaceRuns.noBillingGate).toBe(true);
    expect(pauseWorkspaceRuns.sensitivity).toBe("high");
    expect(pauseWorkspaceRuns.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
    expect(pauseWorkspaceRuns.agent).toEqual({
      requiresApproval: true,
      riskLevel: "high",
      category: "control",
    });
  });

  it("grants org Owner and Admin and workspace Owner, and no Member", () => {
    expect(pauseWorkspaceRuns.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
  });

  it("takes a reason and nothing else: the workspace is the caller's scope", () => {
    expect(pauseWorkspaceRuns.input.parse({ reason: "Cost spike" })).toEqual({
      reason: "Cost spike",
    });
    const bad = [
      {},
      { reason: "" },
      { reason: "x".repeat(COMMAND_REASON_MAX + 1) },
      { reason: "Cost spike", workspaceId: "ws_1" },
    ];
    for (const input of bad) {
      expect(pauseWorkspaceRuns.input.safeParse(input).success).toBe(false);
    }
  });

  it("answers any agent key the session column holds, so a committed pause is never refused", () => {
    // The column is unbounded text, and the ingest envelope allows 512
    // characters. A 128-character cap here rejected the output after the
    // pause and its audit row had committed.
    const receipt = {
      queued: 0,
      commandIds: [],
      skipped: [
        {
          runId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
          agentKey: `acme.platform.${"release-manager-".repeat(10)}laptop`,
          reason: "host_offline",
          commandId: "tcm_c",
        },
      ],
    };
    expect(receipt.skipped[0]?.agentKey.length).toBeGreaterThan(128);
    expect(pauseWorkspaceRuns.output.safeParse(receipt).success).toBe(true);
  });

  it("separates the runs that took the pause from the ones skipped, with why", () => {
    const receipt = {
      queued: 2,
      commandIds: ["tcm_a", "tcm_b"],
      skipped: [
        {
          runId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
          agentKey: "acme.core.cc-laptop",
          reason: "host_offline",
          commandId: "tcm_c",
        },
      ],
    };
    expect(pauseWorkspaceRuns.output.parse(receipt)).toEqual(receipt);
    expect(
      pauseWorkspaceRuns.output.safeParse({
        ...receipt,
        skipped: [{ ...receipt.skipped[0], reason: "observe_tier" }],
      }).success,
    ).toBe(false);
    expect(
      pauseWorkspaceRuns.output.safeParse({
        ...receipt,
        skipped: [{ ...receipt.skipped[0], runId: "run_1" }],
      }).success,
    ).toBe(false);
  });
});
