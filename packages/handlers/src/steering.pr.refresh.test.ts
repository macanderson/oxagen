// refresh_steering_pr (#5077; ADR-184 decision 5): the host is read first and
// the proposal follows it. A close on the host closes the proposal with no
// closer, a moved head resets the checks, a merge on the host asks the sync
// to publish it, and a second call moves nothing. get_steering_pr then names
// the close as one the host made, and a dismissal in Oxagen as one a person
// made.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (actor: { userId: string | null }) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    if (gate.refuse)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Member";
  },
}));

import { createGetSteeringPrHandler } from "./steering.pr.get";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createRefreshSteeringPrHandler } from "./steering.pr.refresh";
import { createProposeRecordHandler } from "./steering.proposal.create";
import { createDismissProposalHandler } from "./steering.proposal.dismiss";
import {
  AUTHOR,
  REVIEWER,
  ctx,
  harness,
} from "./context.steering.test-support";

const proposal = () =>
  steeringProposalCreate.input.parse({
    record: {
      lineageId: "ctx.platform.migration-order",
      kind: "constraint",
      force: "must",
      constraintEffect: "forbid",
      sharingScope: "workspace",
      statement: "Never renumber a merged migration.",
    },
    rationale: "3 data-layer drift findings.",
    support: { runs: ["run_1"], agents: ["a-intel.core.cc"] },
  });

/** A harness with one proposal whose steering PR is open and passed its checks. */
async function opened() {
  const h = harness();
  const requestSync = vi.fn(async () => undefined);
  const deps = { ...h, requestSync };
  const { proposalId } = await createProposeRecordHandler(h)(proposal(), ctx());
  await createOpenSteeringPrHandler(h)({ proposalId }, ctx());
  const row = () => h.store.proposals.find((p) => p.publicId === proposalId)!;
  const pull = () => h.github.pulls.find((p) => p.number === row().prNumber)!;
  return {
    h,
    requestSync,
    proposalId,
    row,
    pull,
    refresh: createRefreshSteeringPrHandler(deps),
    get: createGetSteeringPrHandler(h),
  };
}

beforeEach(() => {
  gate.refuse = false;
});

describe("refresh_steering_pr", () => {
  it("answers no host and moves nothing before a pull request opens", async () => {
    const h = harness();
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    const out = await createRefreshSteeringPrHandler(h)({ proposalId }, ctx());
    expect(out).toEqual({
      proposalId,
      status: "proposed",
      host: null,
      changed: false,
      syncRequested: false,
    });
  });

  it("leaves an open pull request whose head the checks ran on as it is", async () => {
    const t = await opened();
    expect(t.row().status).toBe("checks_passed");
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({
      status: "checks_passed",
      host: { state: "open", headSha: t.row().headSha, baseRef: "main" },
      changed: false,
      syncRequested: false,
    });
  });

  it("closes a proposal whose pull request the host closed, with no closer, and deletes the branch", async () => {
    const t = await opened();
    const branch = t.row().branch!;
    await t.h.github.closePullRequest(t.h.github.repository!, t.pull().number);
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({
      status: "rejected",
      host: { state: "closed" },
      changed: true,
    });
    expect(t.row()).toMatchObject({
      status: "rejected",
      dismissedReason: "Closed on GitHub without merging",
      updatedById: null,
    });
    expect(t.h.github.deletedBranches).toContain(branch);

    const view = await t.get({ proposalId: t.proposalId }, ctx());
    expect(view.closed).toMatchObject({
      reason: "Closed on GitHub without merging",
      byUserId: null,
      byName: null,
      onHost: true,
    });

    // The second call finds it settled and moves nothing.
    const again = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(again).toMatchObject({ status: "rejected", changed: false });
  });

  it("resets the checks to pending when the branch moved on the host after they ran", async () => {
    const t = await opened();
    const before = t.row().headSha;
    const moved = t.h.github.commit(
      t.row().branch!,
      t.row().path!,
      "edited by hand on GitHub",
    );
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({
      status: "pr_open",
      host: { state: "open", headSha: moved },
      changed: true,
    });
    expect(t.row().headSha).not.toBe(before);
    expect(t.row().checks.every((c) => c.status === "pending")).toBe(true);
  });

  it("asks the repository sync to publish a merge on the host and never publishes it here", async () => {
    const t = await opened();
    Object.assign(t.pull(), {
      state: "closed",
      merged: true,
      mergeCommitSha: "0000000000000000000000000000000000000777",
      mergedAt: new Date("2026-09-15T10:00:00.000Z"),
    });
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({
      status: "checks_passed",
      host: { state: "merged" },
      changed: false,
      syncRequested: true,
    });
    expect(t.requestSync).toHaveBeenCalledTimes(1);
    expect(t.row().status).toBe("checks_passed");
  });

  it("answers the proposal as another write left it when that write moved it first, and deletes no branch", async () => {
    const t = await opened();
    const branch = t.row().branch!;
    await t.h.github.closePullRequest(t.h.github.repository!, t.pull().number);
    // A merge from Oxagen lands between the host read and this write.
    const update = t.h.store.updateProposal.bind(t.h.store);
    t.h.store.updateProposal = async (id, patch, from, guard) => {
      t.h.store.updateProposal = update;
      await update(id, { status: "merged" }, ["checks_passed"]);
      return update(id, patch, from, guard);
    };
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({ status: "merged", changed: false });
    expect(t.h.github.deletedBranches).not.toContain(branch);
  });

  it("rethrows a store failure that is not a lost race (negative)", async () => {
    const t = await opened();
    await t.h.github.closePullRequest(t.h.github.repository!, t.pull().number);
    t.h.store.updateProposal = async () => {
      throw new Error("db down");
    };
    await expect(
      t.refresh({ proposalId: t.proposalId }, ctx()),
    ).rejects.toThrow("db down");
  });

  it("answers no sync requested when the deps carry no way to ask for one", async () => {
    const t = await opened();
    Object.assign(t.pull(), { state: "closed", merged: true });
    const out = await createRefreshSteeringPrHandler(t.h)(
      { proposalId: t.proposalId },
      ctx(),
    );
    expect(out).toMatchObject({ syncRequested: false, changed: false });
  });

  it("leaves the checks of a pull request not yet checked when its head moves", async () => {
    const t = await opened();
    t.row().status = "pr_open";
    t.h.github.commit(t.row().branch!, t.row().path!, "edited by hand");
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({ status: "pr_open", changed: false });
  });

  it("leaves a proposal a merge from Oxagen has claimed to that merge", async () => {
    const t = await opened();
    await t.h.github.closePullRequest(t.h.github.repository!, t.pull().number);
    t.row().mergeClaimedAt = t.h.now();
    const write = vi.spyOn(t.h.store, "updateProposal");
    const out = await t.refresh({ proposalId: t.proposalId }, ctx());
    expect(out).toMatchObject({ status: "checks_passed", changed: false });
    // The handler leaves it before any write, not only the store's guard.
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a caller without a workspace role and reads nothing (negative)", async () => {
    const t = await opened();
    gate.refuse = true;
    const find = vi.spyOn(t.h.store, "findProposal");
    const read = vi.spyOn(t.h.github, "getPullRequest");
    await expect(
      t.refresh({ proposalId: t.proposalId }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(find).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an unknown proposal (negative)", async () => {
    const t = await opened();
    await expect(
      t.refresh({ proposalId: "prp_missing" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "proposal_not_found" });
  });

  it("carries the host's refusal and writes nothing when the repository is gone (negative)", async () => {
    const t = await opened();
    t.h.github.repository = null;
    await expect(
      t.refresh({ proposalId: t.proposalId }, ctx()),
    ).rejects.toMatchObject({ reason: "workspace_repository_missing" });
    expect(t.row().status).toBe("checks_passed");
  });
});

describe("get_steering_pr after a close in Oxagen", () => {
  it("names the person who closed it, records no reason when none was given, and is not a close on the host", async () => {
    const t = await opened();
    t.h.store.names.set(AUTHOR, "Dana Reyes");
    await createDismissProposalHandler(t.h)(
      { proposalId: t.proposalId },
      ctx(),
    );
    const view = await t.get({ proposalId: t.proposalId }, ctx());
    expect(view.closed).toMatchObject({
      reason: null,
      byUserId: AUTHOR,
      byName: "Dana Reyes",
      onHost: false,
    });
    expect(view.raised).toMatchObject({
      statement: "Never renumber a merged migration.",
      source: `user:${AUTHOR}`,
      sourceName: "Dana Reyes",
      support: { runs: ["run_1"], agents: ["a-intel.core.cc"] },
    });
  });
});

describe("get_steering_pr names only who Oxagen recorded (#5077)", () => {
  it("prints a source that names someone else as written, never as their name", async () => {
    const h = harness();
    h.store.names.set(REVIEWER, "Owner Name");
    const { proposalId } = await createProposeRecordHandler(h)(
      steeringProposalCreate.input.parse({
        ...proposal(),
        source: `user:${REVIEWER}`,
      }),
      ctx(),
    );
    const view = await createGetSteeringPrHandler(h)({ proposalId }, ctx());
    expect(view.raised).toMatchObject({
      source: `user:${REVIEWER}`,
      sourceName: null,
    });
  });

  it("never calls a close on a proposal with no pull request a close on the host", async () => {
    const h = harness();
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    const row = h.store.proposals[0]!;
    await h.store.updateProposal(
      row.id,
      { status: "rejected", dismissedReason: "duplicate", updatedById: null },
      ["proposed"],
    );
    const view = await createGetSteeringPrHandler(h)({ proposalId }, ctx());
    expect(view.closed).toMatchObject({ onHost: false, reason: "duplicate" });
  });
});
