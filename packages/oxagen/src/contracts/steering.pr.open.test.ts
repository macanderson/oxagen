import { describe, expect, it } from "vitest";
import { steeringPrOpen, steeringPrSchema } from "./steering.pr.open";

export const steeringPrFixture = {
  proposalId: "prp_0123456789abcdefghjkmn",
  lineageId: "ctx.release.no-reread-changelog",
  kind: "rule",
  status: "checks_passed",
  governanceMode: "team",
  pr: {
    number: 519,
    url: "https://github.com/a-intel/platform/pull/519",
    provider: "github",
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
  raised: {
    statement: "Do not re-read CHANGELOG.md more than once in a run.",
    rationale: "Three runs re-read it.",
    source: "reflector · run_01K5RH3G8K5PAS7D",
    sourceName: null,
    force: "should",
    constraintEffect: null,
    sharingScope: "workspace",
    support: { runs: ["run_1"], agents: [], recordIds: [], evidenceLinks: [] },
    at: "2026-09-15T00:00:00.000Z",
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
  closed: null,
};

describe("open_steering_pr contract", () => {
  it("is a governed write with approval, unmetered, open to every workspace member", () => {
    expect(steeringPrOpen.name).toBe("open_steering_pr");
    expect(steeringPrOpen.mutates).toBe(true);
    expect(steeringPrOpen.noBillingGate).toBe(true);
    expect(steeringPrOpen.agent?.requiresApproval).toBe(true);
    expect(steeringPrOpen.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  it("declares the api surface only: the PR is opened from the operator console", () => {
    expect(steeringPrOpen.surfaces).toEqual(["api", "agent"]);
    expect(steeringPrOpen.layers).not.toContain("mcp");
    expect(steeringPrOpen.layers).not.toContain("cli");
  });

  it("takes only the proposal id", () => {
    expect(steeringPrOpen.input.safeParse({ proposalId: "prp_1" }).success).toBe(
      true,
    );
    expect(
      steeringPrOpen.input.safeParse({ proposalId: "prp_1", branch: "x" })
        .success,
    ).toBe(false);
  });

  it("answers the steering PR: state, PR, stamped record, checks, what merge will do", () => {
    expect(steeringPrSchema.safeParse(steeringPrFixture).success).toBe(true);
    // Before the PR opens nothing has read governance.toml.
    expect(
      steeringPrSchema.safeParse({
        ...steeringPrFixture,
        status: "proposed",
        governanceMode: null,
        onMerge: { ...steeringPrFixture.onMerge, review: null },
      }).success,
    ).toBe(true);
    expect(
      steeringPrSchema.safeParse({ ...steeringPrFixture, status: "candidate" })
        .success,
    ).toBe(false);
    // A close names whether the host made it (#5077).
    expect(
      steeringPrSchema.safeParse({
        ...steeringPrFixture,
        status: "rejected",
        closed: {
          at: "2026-09-15T01:00:00.000Z",
          reason: null,
          byUserId: null,
          byName: null,
          onHost: true,
        },
      }).success,
    ).toBe(true);
    expect(
      steeringPrSchema.safeParse({ ...steeringPrFixture, closed: undefined })
        .success,
    ).toBe(false);
  });
});
