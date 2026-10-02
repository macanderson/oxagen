// The steering PR writes through the real kernel seam. The viewer resolution
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran: ok, invalid (refused
// before the kernel), and denied and conflict with the handler's reason
// (INV-19).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { steeringPrOpenOutput } from "@/test/steering-outputs";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  approveSteeringPr,
  dismissProposal,
  dropMemoryRecord,
  forgetMemory,
  mergeSteeringPr,
  mergePrWithoutReview,
  openSteeringPr,
  refreshSteeringPr,
  restoreManagedBlock,
  revertSteeringPr,
  setGovernanceMode,
} = await import("./actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const ID = "prp_01k5ru4a";
const MEMORY_PR = 12;
const RECORD_PATH = "steering/memory/workspace/general/no-reread-changelog.md";
/** The CapabilityContext every write reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};
const refused = (code: "forbidden" | "conflict", reason: string) =>
  new kernel.HandlerError({ code, reason });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("openSteeringPr", () => {
  it("opens the pull request for the workspace viewer and returns where the machine stopped", async () => {
    invoke.mockResolvedValue(steeringPrOpenOutput({ status: "checks_failed" }));
    expect(await openSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: { status: "checks_failed" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "open_steering_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a malformed proposal id before the kernel runs (negative)", async () => {
    expect(await openSteeringPr("acme", "core-platform", "ctr_1")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "proposalId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied with its reason (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    expect(await openSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("returns a second pull request on the lineage as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "lineage_pr_open"));
    expect(await openSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    });
  });
});

describe("mergeSteeringPr", () => {
  it("merges and returns the merge commit", async () => {
    invoke.mockResolvedValue({
      proposalId: ID,
      status: "merged",
      kind: "rule",
      record: {
        id: "ctr_7k2m9q4x",
        lineageId: "ctx.release.no-reread-changelog",
        version: 1,
        path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
      },
      mergedCommit: "4d5e6f7a8b9c",
      promotionEvent: { id: "ctp_8qm2x4", seq: 42, chainDigest: "sha256:ab" },
      bundleVersion: { before: 41, after: 42 },
      publishedVersion: null,
    });
    expect(await mergeSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: { commit: "4d5e6f7a8b9c" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "merge_steering_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a merge before the checks passed as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "checks_not_passed"));
    expect(await mergeSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "checks_not_passed",
    });
  });

  it("returns the author merging their own proposal under team mode as denied (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "separation_of_duties"));
    expect(await mergeSteeringPr("acme", "core-platform", ID)).toMatchObject({
      ok: false,
      reason: "denied",
      code: "separation_of_duties",
    });
  });
});

describe("mergePrWithoutReview", () => {
  it("merges without an approval and returns the merge commit", async () => {
    invoke.mockResolvedValue({
      proposalId: ID,
      status: "merged",
      kind: "rule",
      record: {
        id: "ctr_7k2m9q4x",
        lineageId: "ctx.release.no-reread-changelog",
        version: 1,
        path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
      },
      mergedCommit: "4d5e6f7a8b9c",
      promotionEvent: { id: "ctp_8qm2x4", seq: 42, chainDigest: "sha256:ab" },
      bundleVersion: { before: 41, after: 42 },
      publishedVersion: null,
    });
    expect(await mergePrWithoutReview("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: { commit: "4d5e6f7a8b9c" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "merge_pr_without_review",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a caller without the permission as denied (negative)", async () => {
    invoke.mockRejectedValue(
      refused("forbidden", "merge_without_review_not_held"),
    );
    expect(
      await mergePrWithoutReview("acme", "core-platform", ID),
    ).toMatchObject({
      ok: false,
      reason: "denied",
      code: "merge_without_review_not_held",
    });
  });
});

describe("dismissProposal", () => {
  it("dismisses with the reason trimmed", async () => {
    invoke.mockResolvedValue({ proposalId: ID, status: "rejected" });
    expect(
      await dismissProposal("acme", "core-platform", ID, "  Duplicate  "),
    ).toEqual({ ok: true, value: { status: "rejected" } });
    expect(invoke).toHaveBeenCalledWith(
      "dismiss_proposal",
      { proposalId: ID, reason: "Duplicate" },
      expect.objectContaining(TENANT),
    );
  });

  // Close without merging takes an optional reason (#5077): a blank one is
  // sent as none, never as an empty string the contract refuses.
  it("closes with no reason when the reason is blank", async () => {
    invoke.mockResolvedValue({ proposalId: ID, status: "rejected" });
    expect(await dismissProposal("acme", "core-platform", ID, "   ")).toEqual({
      ok: true,
      value: { status: "rejected" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "dismiss_proposal",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("carries the host's refusal to close and changes nothing (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "github_refused"));
    expect(await dismissProposal("acme", "core-platform", ID, "")).toEqual({
      ok: false,
      reason: "conflict",
      code: "github_refused",
    });
  });

  it("returns a merged proposal as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "proposal_merged"));
    expect(await dismissProposal("acme", "core-platform", ID, "x")).toEqual({
      ok: false,
      reason: "conflict",
      code: "proposal_merged",
    });
  });
});

describe("refreshSteeringPr", () => {
  it("reads the pull request from the host and answers what moved", async () => {
    invoke.mockResolvedValue({
      proposalId: ID,
      status: "rejected",
      host: { state: "closed", headSha: "abc", baseRef: "main" },
      changed: true,
      syncRequested: false,
    });
    expect(await refreshSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: {
        changed: true,
        syncRequested: false,
        host: { state: "closed", headSha: "abc", baseRef: "main" },
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "refresh_steering_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("carries the host's refusal (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "github_refused"));
    expect(await refreshSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "github_refused",
    });
  });
});

describe("revertSteeringPr", () => {
  it("opens the revert and returns its pull request and check", async () => {
    invoke.mockResolvedValue({
      proposalId: ID,
      reverted: { number: 519, mergedCommit: "4d5e6f7a8b9c" },
      pullRequest: {
        number: 520,
        url: "https://github.com/acme/oxagen-core-platform/pull/520",
        branch: "steering/revert-519",
        headSha: "9f8e7d6c",
      },
      check: "success",
    });
    expect(await revertSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: {
        number: 520,
        url: "https://github.com/acme/oxagen-core-platform/pull/520",
        branch: "steering/revert-519",
        check: "success",
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "revert_steering_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a proposal that has not merged as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "not_merged"));
    expect(await revertSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "not_merged",
    });
  });

  it("returns a member the governance mode does not let merge as denied (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    expect(await revertSteeringPr("acme", "core-platform", ID)).toMatchObject({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });
});

describe("a person the workspace refuses", () => {
  it.each([
    ["openSteeringPr", () => openSteeringPr("acme", "x", ID)],
    ["mergeSteeringPr", () => mergeSteeringPr("acme", "x", ID)],
    ["dismissProposal", () => dismissProposal("acme", "x", ID, "why")],
    ["refreshSteeringPr", () => refreshSteeringPr("acme", "x", ID)],
    ["approveSteeringPr", () => approveSteeringPr("acme", "x", ID)],
    ["mergePrWithoutReview", () => mergePrWithoutReview("acme", "x", ID)],
    ["revertSteeringPr", () => revertSteeringPr("acme", "x", ID)],
    [
      "dropMemoryRecord",
      () => dropMemoryRecord("acme", "x", MEMORY_PR, RECORD_PATH),
    ],
    [
      "restoreManagedBlock",
      () => restoreManagedBlock("acme", "x", ID, "AGENTS.md"),
    ],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("approveSteeringPr", () => {
  it("approves the head and returns how many people approved it", async () => {
    invoke.mockResolvedValue({
      proposalId: ID,
      headSha: "4d5e6f7a8b9c",
      approvals: 2,
    });
    expect(await approveSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: { approvals: 2 },
    });
    expect(invoke).toHaveBeenCalledWith(
      "approve_steering_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("returns the author's own approval as denied with its reason (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "author_cannot_approve"));
    expect(await approveSteeringPr("acme", "core-platform", ID)).toMatchObject({
      ok: false,
      reason: "denied",
      code: "author_cannot_approve",
    });
  });

  it("returns a head that moved after the checks as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "head_moved"));
    expect(await approveSteeringPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "head_moved",
    });
  });

  it("refuses a malformed proposal id before the kernel runs (negative)", async () => {
    expect(await approveSteeringPr("acme", "core-platform", "ctr_1")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "proposalId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("dropMemoryRecord", () => {
  it("drops the record by the memory PR's number and returns the commit", async () => {
    invoke.mockResolvedValue({
      pull_request: {
        number: MEMORY_PR,
        url: "https://github.com/acme/steering/pull/12",
        branch: "memory/2026-09-27",
      },
      path: RECORD_PATH,
      lineage: "no-reread-changelog",
      commit_sha: "9a8b7c6d5e4f",
      already_dropped: false,
    });
    expect(
      await dropMemoryRecord("acme", "core-platform", MEMORY_PR, RECORD_PATH),
    ).toEqual({ ok: true, value: { commitSha: "9a8b7c6d5e4f" } });
    expect(invoke).toHaveBeenCalledWith(
      "drop_memory_record",
      { number: MEMORY_PR, path: RECORD_PATH },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a settled memory PR as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "memory_pr_settled"));
    expect(
      await dropMemoryRecord("acme", "core-platform", MEMORY_PR, RECORD_PATH),
    ).toEqual({ ok: false, reason: "conflict", code: "memory_pr_settled" });
  });

  it("refuses a number that names no pull request before the kernel runs (negative)", async () => {
    expect(
      await dropMemoryRecord("acme", "core-platform", 0, RECORD_PATH),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "number",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("restoreManagedBlock", () => {
  it("restores the block through restore_managed_block and returns the commit", async () => {
    invoke.mockResolvedValue({ commit_sha: "7c1d2e3f", status: "checks_passed" });
    expect(
      await restoreManagedBlock("acme", "core-platform", ID, "AGENTS.md"),
    ).toEqual({ ok: true, value: { commitSha: "7c1d2e3f" } });
    expect(invoke).toHaveBeenCalledWith(
      "restore_managed_block",
      { proposalId: ID, path: "AGENTS.md" },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a block that already matches the production branch as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "block_intact"));
    expect(
      await restoreManagedBlock("acme", "core-platform", ID, "CLAUDE.md"),
    ).toEqual({ ok: false, reason: "conflict", code: "block_intact" });
  });

  it("refuses a file that holds no managed block before the kernel runs (negative)", async () => {
    expect(
      await restoreManagedBlock(
        "acme",
        "core-platform",
        ID,
        "steering/constraints/acme.md",
      ),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "path",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("setGovernanceMode", () => {
  const OUT = {
    outcome: "proposed",
    requestedMode: "regulated",
    previousMode: "team",
    effectiveMode: "team",
    fullName: "acme/platform",
    productionBranch: "main",
    path: ".oxagen/rules/governance.toml",
    commitSha: null,
    pullRequest: {
      number: 42,
      htmlUrl: "https://github.com/acme/platform/pull/42",
      reused: false,
    },
    overrodeReview: false,
    proposalId: null,
  } as const;

  it("writes governance.toml for the workspace viewer, never skipping review, and returns what happened", async () => {
    invoke.mockResolvedValue(OUT);
    expect(
      await setGovernanceMode("acme", "core-platform", "regulated"),
    ).toEqual({
      ok: true,
      value: {
        outcome: "proposed",
        mode: "regulated",
        repository: "acme/platform",
        branch: "main",
        path: ".oxagen/rules/governance.toml",
        pullRequest: {
          number: 42,
          htmlUrl: "https://github.com/acme/platform/pull/42",
        },
        proposalId: null,
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "set_governance_mode",
      { mode: "regulated", applyImmediately: false },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a solo commit with no pull request", async () => {
    invoke.mockResolvedValue({
      ...OUT,
      outcome: "applied",
      requestedMode: "team",
      previousMode: "solo",
      effectiveMode: "team",
      commitSha: "9f8e7d6c",
      pullRequest: null,
    });
    const result = await setGovernanceMode("acme", "core-platform", "team");
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "applied", mode: "team", pullRequest: null },
    });
  });

  it("names the file the mode lives in for a steering repository (#4821)", async () => {
    invoke.mockResolvedValue({
      ...OUT,
      path: "steering/governance.toml",
      proposalId: "prp_01k6c0v3",
    });
    const result = await setGovernanceMode("acme", "core-platform", "regulated");
    // The proposal is what a reviewer lands from Proposals (ADR-232).
    expect(result).toMatchObject({
      ok: true,
      value: { path: "steering/governance.toml", proposalId: "prp_01k6c0v3" },
    });
  });

  it("refuses a mode the contract does not know before the kernel runs (negative)", async () => {
    expect(await setGovernanceMode("acme", "core-platform", "anarchy")).toEqual(
      { ok: false, reason: "invalid", field: "mode", code: "invalid_input" },
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(requireViewer).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied with its reason (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    expect(await setGovernanceMode("acme", "core-platform", "solo")).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("returns a workspace with no GitHub installation as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "github_not_connected"));
    expect(await setGovernanceMode("acme", "core-platform", "solo")).toEqual({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
  });
});

describe("forgetMemory", () => {
  const REF = "4f1c2e9a-8b7d-4c6e-9f0a-1b2c3d4e5f60";
  /** update_memory's answer: the node as it now reads. */
  const retracted = {
    id: REF,
    publicId: "0c9d8e7f-6a5b-4c3d-8e1f-2a3b4c5d6e7f",
    nodeRef: "workspace",
    memoryClass: "OBSERVATION",
    memoryKind: "gotcha",
    lesson:
      "The checkout e2e suite failed twice on Safari and passed on retry.",
    source: "fix",
    confidenceScore: 60,
    enforcementScore: null,
    status: "RETRACTED",
    subjectHint: "",
    halfLifeDays: 30,
    decayFloor: 10,
    lastEvidenceAt: null,
    citationCount: 6,
    influenceCount: 2,
    violationCount: 0,
    createdByKind: "AGENT",
    createdById: null,
    confirmedByKind: null,
    confirmedById: null,
    createdAt: "2026-09-02T16:40:00.000Z",
    lastReinforcedAt: null,
  };

  it("retracts the memory through update_memory and never deletes it", async () => {
    invoke.mockResolvedValue(retracted);
    expect(await forgetMemory("acme", "core-platform", REF)).toEqual({
      ok: true,
      value: { forgotten: REF },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "update_memory",
      { memoryId: REF, status: "RETRACTED" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty reference before the kernel runs (negative)", async () => {
    expect(await forgetMemory("acme", "core-platform", "  ")).toEqual({
      ok: false,
      reason: "invalid",
      field: "memoryRef",
      code: "invalid_input",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(requireViewer).not.toHaveBeenCalled();
  });

  it("returns the kernel's role refusal as denied with nothing changed (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "workspace_role_required"));
    expect(await forgetMemory("acme", "core-platform", REF)).toEqual({
      ok: false,
      reason: "denied",
      code: "workspace_role_required",
    });
  });
});
