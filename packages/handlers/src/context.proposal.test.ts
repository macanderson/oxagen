import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";

// The role gate reads iam.principal_role_assignments; the tests decide it.
const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
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

import { createProposeRecordHandler } from "./context.proposal.create";
import { createListProposalsHandler } from "./context.proposal.list";
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import { AUTHOR, ctx, harness } from "./context.steering.test-support";

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
    await h.store.updateProposal(h.store.proposals[0]!.id, {
      status: "merged",
    });
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
