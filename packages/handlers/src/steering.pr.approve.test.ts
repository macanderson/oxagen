/**
 * approve_steering_pr (#4518, ADR-267) over the steering test harness: a
 * repository in team mode, a proposal raised by AUTHOR with its steering PR
 * open, and no approval on the host. The IAM reads are replaced, and the
 * contract's role check is a spy.
 */
import { HandlerError } from "@oxagen/oxagen";
import { steeringPrApprove } from "@oxagen/oxagen/contracts/steering.pr.approve";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { describe, expect, it, vi } from "vitest";

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

import { createApproveSteeringPrHandler } from "./steering.pr.approve";
import { createMergeSteeringPrHandler } from "./steering.pr.merge";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createDismissProposalHandler } from "./steering.proposal.dismiss";
import { createProposeRecordHandler } from "./steering.proposal.create";
import {
  AUTHOR,
  REVIEWER,
  ctx,
  harness,
  type Harness,
} from "./context.steering.test-support";

const LINEAGE = "ctx.release.notes-before-tag";
const BRANCH = `steering/${LINEAGE}`;
const GOVERNANCE = ".oxagen/rules/governance.toml";
const MEMBER = "0192d4a8-7c1e-7a00-8000-0000000005e3";

/** A repository in team mode, with no approval on the host. */
function teamRepo(): Harness {
  const h = harness({ [`main:${GOVERNANCE}`]: 'mode = "team"\n' });
  h.github.approvals = [];
  h.roleOf.set(MEMBER, { org: null, workspace: "Member" });
  return h;
}

/** A proposal AUTHOR raised. Answers its id. */
async function raised(h: Harness): Promise<string> {
  const { proposalId } = await createProposeRecordHandler(h)(
    steeringProposalCreate.input.parse({
      record: {
        lineageId: LINEAGE,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: "Write the release notes before you tag a release.",
      },
      rationale: "Three releases shipped with no notes.",
    }),
    ctx(),
  );
  return proposalId;
}

/** A proposal AUTHOR raised, with its steering PR open and its checks passed. */
async function opened(h: Harness): Promise<string> {
  const proposalId = await raised(h);
  const out = await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
  expect(out.status).toBe("checks_passed");
  return proposalId;
}

function approve(h: Harness) {
  const assertRole = vi.fn(async () => undefined);
  return {
    handler: createApproveSteeringPrHandler({ ...h, assertRole }),
    assertRole,
  };
}

async function refusal(run: Promise<unknown>): Promise<HandlerError> {
  try {
    await run;
  } catch (err) {
    return err as HandlerError;
  }
  throw new Error("The approval went through, and the test expected a refusal.");
}

describe("approve_steering_pr", () => {
  it("records the approval at the checked head, and the merge counts it with no approval on the host", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    const merge = createMergeSteeringPrHandler(h);

    // Before anyone approves, a merger who is not an owner is refused.
    await expect(
      refusal(merge({ proposalId }, ctx({ userId: REVIEWER }))),
    ).resolves.toMatchObject({ reason: "approval_required" });

    const { handler, assertRole } = approve(h);
    const out = await handler(
      steeringPrApprove.input.parse({ proposalId }),
      ctx({ userId: MEMBER }),
    );
    const head = h.store.proposals[0]!.headSha!;
    expect(out).toEqual({ proposalId, headSha: head, approvals: 1 });
    expect(assertRole).toHaveBeenCalledTimes(1);
    expect(h.store.approvals).toEqual([
      expect.objectContaining({
        proposalId: h.store.proposals[0]!.id,
        userId: MEMBER,
        commitSha: head,
      }),
    ]);

    const merged = await merge({ proposalId }, ctx({ userId: REVIEWER }));
    expect(merged.status).toBe("merged");
    expect(h.github.merges[0]!.commitMessage).toContain(
      `Oxagen-Approved-By: ${MEMBER}`,
    );
  });

  it("counts each person once, and approving the same head again records nothing new", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    const { handler } = approve(h);
    const input = steeringPrApprove.input.parse({ proposalId });

    await handler(input, ctx({ userId: MEMBER }));
    await expect(handler(input, ctx({ userId: MEMBER }))).resolves.toMatchObject(
      { approvals: 1 },
    );
    await expect(
      handler(input, ctx({ userId: REVIEWER })),
    ).resolves.toMatchObject({ approvals: 2 });
    expect(h.store.approvals).toHaveLength(2);
  });

  it("refuses a call with no signed-in person, before reading anything (negative)", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    const { handler, assertRole } = approve(h);
    const err = await refusal(
      handler({ proposalId }, ctx({ userId: null, apiKeyId: "key_1" })),
    );
    expect(err).toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(assertRole).not.toHaveBeenCalled();
    expect(h.store.approvals).toHaveLength(0);
  });

  it("refuses the proposal's author, and records nothing (negative)", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    const err = await refusal(approve(h).handler({ proposalId }, ctx()));
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "author_cannot_approve",
    });
    expect(h.store.approvals).toHaveLength(0);
  });

  it("passes on the role check's refusal (negative)", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    const assertRole = vi.fn(async () => {
      throw new HandlerError({ code: "forbidden", reason: "role_required" });
    });
    const handler = createApproveSteeringPrHandler({ ...h, assertRole });
    await expect(
      refusal(handler({ proposalId }, ctx({ userId: MEMBER }))),
    ).resolves.toMatchObject({ reason: "role_required" });
    expect(h.store.approvals).toHaveLength(0);
  });

  it("refuses a proposal the workspace does not hold, and one whose steering PR is not open (negative)", async () => {
    const h = teamRepo();
    const { handler } = approve(h);
    await expect(
      refusal(handler({ proposalId: "prp_missing" }, ctx({ userId: MEMBER }))),
    ).resolves.toMatchObject({
      code: "not_found",
      reason: "proposal_not_found",
    });

    const proposalId = await raised(h);
    await expect(
      refusal(handler({ proposalId }, ctx({ userId: MEMBER }))),
    ).resolves.toMatchObject({ code: "conflict", reason: "pr_not_open" });
    expect(h.store.approvals).toHaveLength(0);
  });

  it("refuses a dismissed proposal (negative)", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    await createDismissProposalHandler(h)({ proposalId }, ctx());
    await expect(
      refusal(approve(h).handler({ proposalId }, ctx({ userId: MEMBER }))),
    ).resolves.toMatchObject({ code: "conflict", reason: "proposal_rejected" });
    expect(h.store.approvals).toHaveLength(0);
  });

  it("refuses a pull request the host closed (negative)", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    h.github.closeOnHost(h.store.proposals[0]!.prNumber!);
    await expect(
      refusal(approve(h).handler({ proposalId }, ctx({ userId: MEMBER }))),
    ).resolves.toMatchObject({ code: "conflict", reason: "pr_not_open" });
    expect(h.store.approvals).toHaveLength(0);
  });

  it("refuses a head that moved after the checks ran, so nobody approves an unchecked head (negative)", async () => {
    const h = teamRepo();
    const proposalId = await opened(h);
    const checked = h.store.proposals[0]!.headSha!;
    const pushed = h.github.commit(BRANCH, "notes.md", "a push\n");
    const err = await refusal(
      approve(h).handler({ proposalId }, ctx({ userId: MEMBER })),
    );
    expect(err).toMatchObject({ code: "conflict", reason: "head_moved" });
    expect(err.message).toContain(pushed);
    expect(err.message).toContain(checked);
    expect(h.store.approvals).toHaveLength(0);
  });
});
