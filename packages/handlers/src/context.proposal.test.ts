import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";

// The role gate reads iam.principal_role_assignments; the tests decide it.
const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
  assertOrgRole: async () => {
    if (gate.refuse) {
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    }
    return "Owner";
  },
}));

import { createMergeContextPrHandler } from "./context.pr.merge";
import { createOpenContextPrHandler } from "./context.pr.open";
import { createProposeRecordHandler } from "./context.proposal.create";
import { createListProposalsHandler } from "./context.proposal.list";
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import {
  AUTHOR,
  REVIEWER,
  ctx,
  harness,
} from "./context.steering.test-support";

const proposal = (over: Record<string, unknown> = {}) =>
  contextProposalCreate.input.parse({
    record: {
      lineageId: "ctx.platform.migration-order",
      kind: "constraint",
      force: "must",
      constraintEffect: "forbid",
      sharingScope: "workspace",
      statement: "Never renumber a merged migration.",
    },
    rationale: "3 data-layer drift findings.",
    support: {
      runs: ["run_1", "run_2"],
      agents: ["a-intel.core.cc"],
      evidenceLinks: ["fnd_01K5RT6C"],
    },
    ...over,
  });

beforeEach(() => {
  gate.refuse = false;
});

describe("propose_record", () => {
  it("records the proposal in the proposed state with its support and the caller as source", async () => {
    const h = harness();
    const out = await createProposeRecordHandler(h)(proposal(), ctx());
    expect(out).toEqual({
      proposalId: h.store.proposals[0]!.publicId,
      lineageId: "ctx.platform.migration-order",
      status: "proposed",
    });
    expect(h.store.proposals[0]).toMatchObject({
      status: "proposed",
      constraintEffect: "forbid",
      supportRuns: ["run_1", "run_2"],
      supportAgents: ["a-intel.core.cc"],
      evidenceLinks: ["fnd_01K5RT6C"],
      source: `user:${AUTHOR}`,
      createdByUserId: AUTHOR,
    });
    const labelled = await createProposeRecordHandler(h)(
      proposal({ source: "findings job · fnd_01K5RT6C" }),
      ctx(),
    );
    expect(
      h.store.proposals.find((p) => p.publicId === labelled.proposalId)?.source,
    ).toBe("findings job · fnd_01K5RT6C");
  });

  it("is refused for a signed-in role the gate excludes and writes no row; a call with no user is left to the kernel", async () => {
    const h = harness();
    gate.refuse = true;
    await expect(
      createProposeRecordHandler(h)(proposal(), ctx()),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(h.store.proposals).toHaveLength(0);
    const out = await createProposeRecordHandler(h)(
      proposal(),
      ctx({ userId: null, apiKeyId: "key_1" }),
    );
    expect(out.status).toBe("proposed");
    expect(h.store.proposals).toHaveLength(1);
  });
});

describe("list_proposals", () => {
  it("lists newest first with support, a null PR and a null check tally before a PR opens, filtered by status", async () => {
    const h = harness();
    const propose = createProposeRecordHandler(h);
    const a = await propose(proposal(), ctx());
    const b = await propose(
      proposal({ record: { ...proposal().record, lineageId: "ctx.other" } }),
      ctx(),
    );
    const list = createListProposalsHandler(h);
    const out = await list(contextProposalList.input.parse({}), ctx());
    expect(out.total).toBe(2);
    expect(out.proposals.map((p) => p.id)).toEqual([
      b.proposalId,
      a.proposalId,
    ]);
    expect(out.proposals[0]).toMatchObject({
      pr: null,
      checks: null,
      support: { runs: ["run_1", "run_2"] },
    });
    expect(() => contextProposalList.output.parse(out)).not.toThrow();
    const none = await list(
      contextProposalList.input.parse({ status: "merged" }),
      ctx(),
    );
    expect(none).toEqual({ proposals: [], total: 0 });
  });
});

describe("dismiss_proposal", () => {
  it("rejects a proposal with the reason, refuses a merged one, and is idempotent", async () => {
    const h = harness();
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    const dismiss = createDismissProposalHandler(h);
    const out = await dismiss(
      { proposalId, reason: "superseded by the migration lint" },
      ctx(),
    );
    expect(out).toEqual({ proposalId, status: "rejected" });
    expect(h.store.proposals[0]).toMatchObject({
      status: "rejected",
      dismissedReason: "superseded by the migration lint",
    });
    expect(h.store.proposals[0]!.dismissedAt).toBeInstanceOf(Date);
    expect(await dismiss({ proposalId, reason: "again" }, ctx())).toEqual({
      proposalId,
      status: "rejected",
    });
    expect(h.store.proposals[0]!.dismissedReason).toBe(
      "superseded by the migration lint",
    );
    await h.store.updateProposal(
      h.store.proposals[0]!.id,
      { status: "merged" },
      ["rejected"],
    );
    await expect(
      dismiss({ proposalId, reason: "x" }, ctx()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "proposal_merged",
    });
    await expect(
      dismiss({ proposalId: "prp_missing", reason: "x" }, ctx()),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("closes an open Context PR and deletes its branch, so the next proposal on the lineage opens a fresh one", async () => {
    const h = harness();
    const open = createOpenContextPrHandler(h);
    const propose = createProposeRecordHandler(h);
    const { proposalId: first } = await propose(proposal(), ctx());
    await open({ proposalId: first }, ctx());
    expect(h.github.pulls[0]).toMatchObject({ number: 519, state: "open" });

    await createDismissProposalHandler(h)(
      { proposalId: first, reason: "wrong lineage" },
      ctx(),
    );
    expect(h.github.pulls[0]).toMatchObject({
      number: 519,
      state: "closed",
      merged: false,
    });
    expect(h.github.deletedBranches).toEqual([
      "context/ctx.platform.migration-order",
    ]);
    expect(h.store.proposals[0]!.status).toBe("rejected");

    const { proposalId: second } = await propose(proposal(), ctx());
    const out = await open({ proposalId: second }, ctx());
    expect(out.status).toBe("checks_passed");
    expect(out.pr?.number).toBe(520);
    expect(h.github.branches).toHaveLength(2);
  });

  it("closes the PR an open left unrecorded and deletes its branch; until then another proposal on the lineage is refused", async () => {
    const h = harness();
    const propose = createProposeRecordHandler(h);
    const open = createOpenContextPrHandler(h);
    const { proposalId: first } = await propose(proposal(), ctx());
    const store = h.store;
    const update = store.updateProposal.bind(store);
    let fail = true;
    store.updateProposal = async (id, patch, from, guard) => {
      if (fail && patch.status === "pr_open") {
        fail = false;
        throw new Error("db blip");
      }
      return update(id, patch, from, guard);
    };
    await expect(open({ proposalId: first }, ctx())).rejects.toThrow("db blip");
    expect(h.github.pulls[0]).toMatchObject({ number: 519, state: "open" });

    const { proposalId: second } = await propose(proposal(), ctx());
    await expect(open({ proposalId: second }, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "lineage_pr_open",
      message: expect.stringContaining("/pull/519"),
    });

    await createDismissProposalHandler(h)(
      { proposalId: first, reason: "abandoned" },
      ctx(),
    );
    expect(h.github.pulls[0]).toMatchObject({
      number: 519,
      state: "closed",
      merged: false,
    });
    expect(h.github.deletedBranches).toEqual([
      "context/ctx.platform.migration-order",
    ]);

    const out = await open({ proposalId: second }, ctx());
    expect(out.status).toBe("checks_passed");
    expect(out.pr?.number).toBe(520);
  });

  it("a merge that publishes while the dismissal is closing the PR keeps its proposal merged, and the dismissal is refused", async () => {
    const h = harness();
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    const github = h.github;
    const close = github.closePullRequest.bind(github);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let parked!: () => void;
    const closing = new Promise<void>((resolve) => (parked = resolve));
    github.closePullRequest = async (repo, number) => {
      parked();
      await hold;
      return close(repo, number);
    };

    const dismissal = createDismissProposalHandler(h)(
      { proposalId, reason: "late" },
      ctx(),
    );
    await closing;
    const merged = await createMergeContextPrHandler(h)(
      { proposalId },
      ctx({ userId: REVIEWER }),
    );
    expect(merged.status).toBe("merged");
    release();

    await expect(dismissal).rejects.toMatchObject({
      code: "conflict",
      reason: "proposal_merged",
    });
    expect(h.store.proposals[0]).toMatchObject({
      status: "merged",
      dismissedReason: null,
    });
    expect(h.store.ledger).toHaveLength(1);
  });

  it("touches GitHub not at all for a proposal that has no PR", async () => {
    const h = harness();
    h.github.repository = null;
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    const out = await createDismissProposalHandler(h)(
      { proposalId, reason: "x" },
      ctx(),
    );
    expect(out.status).toBe("rejected");
  });

  it("is refused for a role the gate excludes, before any row changes", async () => {
    const h = harness();
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    gate.refuse = true;
    await expect(
      createDismissProposalHandler(h)({ proposalId, reason: "x" }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(h.store.proposals[0]!.status).toBe("proposed");
  });
});
