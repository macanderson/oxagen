// get_context_pr_diff (#5077): the files a Context PR's branch changes, each
// read on the production branch and on the head, and nothing once the pull
// request settled and its branch is gone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { contextPrDiffGet } from "@oxagen/oxagen/contracts/context.pr.diff.get";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";

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

import { createGetContextPrDiffHandler } from "./context.pr.diff.get";
import { createOpenContextPrHandler } from "./context.pr.open";
import { createProposeRecordHandler } from "./context.proposal.create";
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import { ctx, harness } from "./context.steering.test-support";

const proposal = () =>
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
  });

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("get_context_pr_diff", () => {
  it("answers no_pr before a pull request opens", async () => {
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    const out = await createGetContextPrDiffHandler(h)({ proposalId }, ctx());
    expect(out).toMatchObject({ state: "no_pr", files: [], moreFiles: false });
    expect(() => contextPrDiffGet.output.parse(out)).not.toThrow();
  });

  it("reads the record file the branch adds, empty before and the committed text after", async () => {
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    const row = h.store.proposals[0]!;
    const out = await createGetContextPrDiffHandler(h)({ proposalId }, ctx());
    expect(out.state).toBe("diff");
    expect(out.baseRef).toBe("main");
    expect(out.headSha).toBe(h.github.heads.get(row.branch!));
    const file = out.files.find((f) => f.path === row.path);
    expect(file).toMatchObject({
      status: "added",
      before: null,
      truncated: false,
    });
    expect(file?.after).toContain("Never renumber a merged migration.");
    expect(() => contextPrDiffGet.output.parse(out)).not.toThrow();
  });

  it("answers settled with no files once the pull request closed and its branch is gone", async () => {
    const { proposalId } = await createProposeRecordHandler(h)(
      proposal(),
      ctx(),
    );
    await createOpenContextPrHandler(h)({ proposalId }, ctx());
    await createDismissProposalHandler(h)({ proposalId }, ctx());
    const out = await createGetContextPrDiffHandler(h)({ proposalId }, ctx());
    expect(out).toMatchObject({ state: "settled", files: [] });
  });

  it("refuses an unknown proposal (negative)", async () => {
    await expect(
      createGetContextPrDiffHandler(h)({ proposalId: "prp_missing" }, ctx()),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
