import { describe, expect, it } from "vitest";
import { contextPrOpen, contextPrSchema } from "./context.pr.open";

export const contextPrFixture = {
  proposalId: "prp_0123456789abcdefghjkmn",
  lineageId: "ctx.release.no-reread-changelog",
  status: "checks_passed",
  governanceMode: "team",
  pr: {
    number: 519,
    url: "https://github.com/a-intel/platform/pull/519",
    repository: "a-intel/platform",
    baseRef: "main",
    branch: "context/ctx.release.no-reread-changelog",
    headSha: "7d2e91a",
    path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
  },
  record: {
    recordId: "rec_release_no_reread_changelog_9a41c0e7bd23",
    recordHash: `sha256:${"9".repeat(64)}`,
    kind: "rule",
    force: "should",
    constraintEffect: null,
    sharingScope: "workspace",
    statement: "Do not re-read CHANGELOG.md more than once in a run.",
  },
  body: "…",
  checks: [],
  onMerge: {
    publishes: {
      lineageId: "ctx.release.no-reread-changelog",
      path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
    },
    bundleVersion: { current: 41, afterMerge: 42 },
    review: "team: an Owner or Admin other than the author merges",
  },
  merged: null,
};

describe("open_context_pr contract", () => {
  it("is a governed write with approval, unmetered, open to every workspace member", () => {
    expect(contextPrOpen.name).toBe("open_context_pr");
    expect(contextPrOpen.mutates).toBe(true);
    expect(contextPrOpen.noBillingGate).toBe(true);
    expect(contextPrOpen.agent?.requiresApproval).toBe(true);
    expect(contextPrOpen.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  it("declares the api surface only: the PR is opened from the operator console", () => {
    expect(contextPrOpen.surfaces).toEqual(["api"]);
    expect(contextPrOpen.layers).not.toContain("mcp");
    expect(contextPrOpen.layers).not.toContain("cli");
  });

  it("takes only the proposal id", () => {
    expect(contextPrOpen.input.safeParse({ proposalId: "prp_1" }).success).toBe(
      true,
    );
    expect(
      contextPrOpen.input.safeParse({ proposalId: "prp_1", branch: "x" })
        .success,
    ).toBe(false);
  });

  it("answers the Context PR: state, PR, stamped record, checks, what merge will do", () => {
    expect(contextPrSchema.safeParse(contextPrFixture).success).toBe(true);
    // Before the PR opens nothing has read governance.toml.
    expect(
      contextPrSchema.safeParse({
        ...contextPrFixture,
        status: "proposed",
        governanceMode: null,
        onMerge: { ...contextPrFixture.onMerge, review: null },
      }).success,
    ).toBe(true);
    expect(
      contextPrSchema.safeParse({ ...contextPrFixture, status: "candidate" })
        .success,
    ).toBe(false);
  });
});
