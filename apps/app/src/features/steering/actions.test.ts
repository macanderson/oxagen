// The Context PR writes through the real kernel seam: the viewer resolution
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran — ok, invalid (refused
// before the kernel), denied and conflict with the handler's reason (INV-19).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextPrOutput } from "@/test/steering-outputs";

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
const { dismissProposal, mergeContextPr, openContextPr, setGovernanceMode } =
  await import("./actions");

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

describe("openContextPr", () => {
  it("opens the pull request for the workspace viewer and returns where the machine stopped", async () => {
    invoke.mockResolvedValue(contextPrOutput({ status: "checks_failed" }));
    expect(await openContextPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: { status: "checks_failed" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "open_context_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a malformed proposal id before the kernel runs (negative)", async () => {
    expect(await openContextPr("acme", "core-platform", "ctr_1")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "proposalId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied with its reason (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    expect(await openContextPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("returns a second pull request on the lineage as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "lineage_pr_open"));
    expect(await openContextPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    });
  });
});

describe("mergeContextPr", () => {
  it("merges and returns the merge commit", async () => {
    invoke.mockResolvedValue({
      proposalId: ID,
      status: "merged",
      record: {
        id: "ctr_7k2m9q4x",
        lineageId: "ctx.release.no-reread-changelog",
        version: 1,
        path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
      },
      mergedCommit: "4d5e6f7a8b9c",
      promotionEvent: { id: "ctp_8qm2x4", seq: 42, chainDigest: "sha256:ab" },
      bundleVersion: { before: 41, after: 42 },
    });
    expect(await mergeContextPr("acme", "core-platform", ID)).toEqual({
      ok: true,
      value: { commit: "4d5e6f7a8b9c" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "merge_context_pr",
      { proposalId: ID },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a merge before the checks passed as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refused("conflict", "checks_not_passed"));
    expect(await mergeContextPr("acme", "core-platform", ID)).toEqual({
      ok: false,
      reason: "conflict",
      code: "checks_not_passed",
    });
  });

  it("returns the author merging their own proposal under team mode as denied (negative)", async () => {
    invoke.mockRejectedValue(refused("forbidden", "separation_of_duties"));
    expect(await mergeContextPr("acme", "core-platform", ID)).toMatchObject({
      ok: false,
      reason: "denied",
      code: "separation_of_duties",
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

  it("refuses a blank reason before the kernel runs (negative)", async () => {
    expect(await dismissProposal("acme", "core-platform", ID, "   ")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
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

describe("a person the workspace refuses", () => {
  it.each([
    ["openContextPr", () => openContextPr("acme", "x", ID)],
    ["mergeContextPr", () => mergeContextPr("acme", "x", ID)],
    ["dismissProposal", () => dismissProposal("acme", "x", ID, "why")],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
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
    commitSha: null,
    pullRequest: {
      number: 42,
      htmlUrl: "https://github.com/acme/platform/pull/42",
      reused: false,
    },
    overrodeReview: false,
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
        pullRequest: {
          number: 42,
          htmlUrl: "https://github.com/acme/platform/pull/42",
        },
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
