// The three role-gated steering writes need a signed-in user. A bearer
// request carries an API key and no user on both machine surfaces
// (`apps/api/src/middleware/auth.ts` sets `userId: null`; `apps/mcp/src/context.ts`
// builds every context with `userId: null`), and the CLI's token is an API
// key. Their contracts therefore declare the `api` surface only, and this
// file runs the real gate (no mock of `@oxagen/iam/org-role`) to show the
// handlers refuse such a context before any store or GitHub call.
import { describe, expect, it } from "vitest";
import { contextPrMerge } from "@oxagen/oxagen/contracts/context.pr.merge";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { createMergeContextPrHandler } from "./context.pr.merge";
import { createOpenContextPrHandler } from "./context.pr.open";
import { createProposeRecordHandler } from "./context.proposal.create";
import { createDismissProposalHandler } from "./context.proposal.dismiss";
import { createAppendRecordHandler } from "./context.records.append";
import { ctx, harness } from "./context.steering.test-support";

const API_KEY_CTX = ctx({ userId: null, apiKeyId: "key_1" });

describe("the role-gated steering writes under an API key", () => {
  it("declare no surface an API key reaches", () => {
    for (const contract of [
      contextPrOpen,
      contextPrMerge,
      contextProposalDismiss,
    ]) {
      expect(contract.surfaces, contract.name).toEqual(["api"]);
    }
  });

  it("refuse with no_principal before touching the store or GitHub", async () => {
    const h = harness();
    await expect(
      createOpenContextPrHandler(h)({ proposalId: "prp_1" }, API_KEY_CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    await expect(
      createMergeContextPrHandler(h)({ proposalId: "prp_1" }, API_KEY_CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    await expect(
      createDismissProposalHandler(h)(
        { proposalId: "prp_1", reason: "x" },
        API_KEY_CTX,
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(h.github.branches).toHaveLength(0);
    expect(h.store.proposals).toHaveLength(0);
  });
});

describe("propose_record and append_record under an API key", () => {
  it("gate only a signed-in user, so an agent's key reaches the store without the role query", async () => {
    const h = harness();
    const record = {
      lineageId: "ctx.triage.reproduce-first",
      statement: "Reproduce before labelling.",
      sharingScope: "workspace",
    };
    await createProposeRecordHandler(h)(
      contextProposalCreate.input.parse({
        record: { ...record, kind: "rule", force: "should" },
        rationale: "14 unsatisfied runs in 30 days.",
      }),
      API_KEY_CTX,
    );
    await createAppendRecordHandler(h)(
      contextRecordsAppend.input.parse({
        ...record,
        kind: "observation",
        sourceRefs: ["frame:run_1/12"],
      }),
      API_KEY_CTX,
    );
    expect(h.store.proposals).toHaveLength(1);
    expect(h.store.appends).toHaveLength(1);
  });
});
