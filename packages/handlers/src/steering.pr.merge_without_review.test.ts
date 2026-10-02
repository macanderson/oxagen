/**
 * merge_pr_without_review (ADR-213) over the steering test harness. The role
 * gate that proposing and opening a PR pass is replaced. The merge's own role
 * rule reads the harness's roles, and the IAM read is replaced by a spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { steeringPrMergeWithoutReview } from "@oxagen/oxagen/contracts/steering.pr.merge_without_review";

const mocks = vi.hoisted(() => ({ holdsCapability: vi.fn() }));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    return "Member";
  },
}));

vi.mock("./lib/capability-holder", () => ({
  holdsCapability: (...args: unknown[]) => mocks.holdsCapability(...args),
}));

import { productionMergeSeams } from "./steering.pr.merge";
import { createMergePrWithoutReviewHandler } from "./steering.pr.merge_without_review";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createProposeRecordHandler } from "./steering.proposal.create";
import {
  AUTHOR,
  REVIEWER,
  SCOPE,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const APPROVED_BY_NOBODY = `Oxagen-Approved-By: none; merged without review by ${REVIEWER}\n`;

/** A proposal with an open PR whose checks passed, at head1. */
async function opened(h: Harness): Promise<string> {
  const { proposalId } = await createProposeRecordHandler(h)(
    steeringProposalCreate.input.parse({
      record: {
        lineageId: "ctx.release.no-reread-changelog",
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement:
          "Do not re-read CHANGELOG.md more than once in a run; cache the first read.",
      },
      rationale: "682 duplicate tool calls across 212 runs.",
      support: {
        runs: ["run_1", "run_2"],
        agents: ["a-intel.core.cc"],
        recordIds: ["cta_1"],
        evidenceLinks: ["fnd_01K5RT6C"],
      },
    }),
    ctx(),
  );
  const pr = await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
  expect(pr.status).toBe("checks_passed");
  return proposalId;
}

/** Nothing merged, published, or recorded, and the proposal still waits. */
function expectUntouched(h: Harness) {
  expect(h.github.merges).toHaveLength(0);
  expect(h.github.deletedBranches).toHaveLength(0);
  expect(h.store.ledger).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  expect(h.store.proposals[0]!.status).toBe("checks_passed");
}

beforeEach(() => {
  mocks.holdsCapability.mockReset();
});

describe("merge_pr_without_review", () => {
  it("lets a holder merge in team mode with no approval, and the trailer says nobody reviewed it", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.approvals = [];
    const holds = vi.fn(async () => true);

    const out = await createMergePrWithoutReviewHandler(h, {
      holdsMergeWithoutReview: holds,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));

    expect(out.status).toBe("merged");
    expect(holds).toHaveBeenCalledWith(
      { orgId: SCOPE.orgId, workspaceId: SCOPE.workspaceId },
      REVIEWER,
    );
    expect(h.github.merges).toHaveLength(1);
    expect(h.github.merges[0]!.commitMessage).toContain(APPROVED_BY_NOBODY);
    expect(h.store.ledger).toHaveLength(1);
    expect(h.store.proposals[0]!.status).toBe("merged");
    expect(h.events).toEqual([
      expect.objectContaining({
        eventType: "steering.published",
        actorUserId: REVIEWER,
        capability: steeringPrMergeWithoutReview.name,
        outcome: "success",
      }),
    ]);
  });

  it("refuses a caller who does not hold it with merge_without_review_not_held, even with an approval, and merges nothing", async () => {
    const h = harness();
    const id = await opened(h);
    h.roleOf.set("u_member", { org: null, workspace: "Member" });
    h.github.approvals = [
      { userId: "u_member", login: "member", commitSha: "head1" },
    ];
    const holds = vi.fn(async () => false);

    await expect(
      createMergePrWithoutReviewHandler(h, { holdsMergeWithoutReview: holds })(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "merge_without_review_not_held",
    });
    expect(holds).toHaveBeenCalledOnce();
    expectUntouched(h);
  });

  it("refuses every caller when no seam answers, because nobody holds it by default", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.approvals = [];
    h.roleOf.set(REVIEWER, { org: "Owner", workspace: null });

    await expect(
      createMergePrWithoutReviewHandler(h)(
        { proposalId: id },
        ctx({ userId: REVIEWER }),
      ),
    ).rejects.toMatchObject({ reason: "merge_without_review_not_held" });
    expectUntouched(h);
  });

  it("refuses an API key with no signed-in user as no_principal before it reads the grant", async () => {
    const h = harness();
    const id = await opened(h);
    const holds = vi.fn(async () => true);

    await expect(
      createMergePrWithoutReviewHandler(h, { holdsMergeWithoutReview: holds })(
        { proposalId: id },
        ctx({ userId: null, apiKeyId: "key_1" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(holds).not.toHaveBeenCalled();
    expectUntouched(h);
  });

  it("still applies the governance mode: a holding workspace Member is refused org_role_required, and the author separation_of_duties", async () => {
    const h = harness();
    const id = await opened(h);
    h.github.approvals = [];
    const merge = createMergePrWithoutReviewHandler(h, {
      holdsMergeWithoutReview: async () => true,
    });

    h.roleOf.set("u_member", { org: null, workspace: "Member" });
    await expect(
      merge({ proposalId: id }, ctx({ userId: "u_member" })),
    ).rejects.toMatchObject({ reason: "org_role_required" });

    h.roleOf.set(AUTHOR, { org: "Admin", workspace: null });
    await expect(
      merge({ proposalId: id }, ctx({ userId: AUTHOR })),
    ).rejects.toMatchObject({ reason: "separation_of_duties" });
    expectUntouched(h);
  });

  it("records an approval that stands at the head as that approval", async () => {
    const h = harness();
    const id = await opened(h);
    h.roleOf.set("u_member", { org: null, workspace: "Member" });
    h.github.approvals = [
      { userId: "u_member", login: "member", commitSha: "head1" },
    ];

    const out = await createMergePrWithoutReviewHandler(h, {
      holdsMergeWithoutReview: async () => true,
    })({ proposalId: id }, ctx({ userId: REVIEWER }));

    expect(out.status).toBe("merged");
    expect(h.github.merges[0]!.commitMessage).toMatch(
      /^Oxagen-Approved-By: u_member\n/,
    );
    expect(h.github.merges[0]!.commitMessage).not.toContain(
      "merged without review",
    );
  });
});

describe("productionMergeSeams", () => {
  it("asks the IAM resolver whether the merger holds merge_pr_without_review", async () => {
    const hold = productionMergeSeams.holdsMergeWithoutReview;
    expect(hold).toBeDefined();

    mocks.holdsCapability.mockResolvedValueOnce(true);
    await expect(hold!(SCOPE, REVIEWER)).resolves.toBe(true);
    mocks.holdsCapability.mockResolvedValueOnce(false);
    await expect(hold!(SCOPE, AUTHOR)).resolves.toBe(false);

    expect(mocks.holdsCapability.mock.calls).toEqual([
      [steeringPrMergeWithoutReview, SCOPE, REVIEWER],
      [steeringPrMergeWithoutReview, SCOPE, AUTHOR],
    ]);
    // The resolver falls to the contract's default for a caller no role
    // grant names, so the default must refuse.
    expect(steeringPrMergeWithoutReview.defaultEffect).toBe("deny");
  });
});
