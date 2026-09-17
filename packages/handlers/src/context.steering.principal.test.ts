// The role-gated steering writes act as the signed-in user or, for an API-key
// call, the key's creator (`resolveActingUserId`; apps/app/ARCHITECTURE.md §9,
// 2026-09-15). This file runs the real gate with only the key lookup
// replaced by a key whose row names no creator: `assertOrgRole` refuses it
// with `no_principal` before any store or GitHub call. `merge_context_pr`
// keeps its own reviewer gate, which needs a signed-in user, so a key is
// refused there too.
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam/org-role")>()),
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
}));

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
const NO_PRINCIPAL = { code: "forbidden", reason: "no_principal" };

describe("the role-gated steering writes under an API key with no creator", () => {
  it("declare the api surface only for the PR writes", () => {
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
    const record = {
      lineageId: "ctx.triage.reproduce-first",
      statement: "Reproduce before labelling.",
      sharingScope: "workspace",
    };
    await expect(
      createOpenContextPrHandler(h)({ proposalId: "prp_1" }, API_KEY_CTX),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createMergeContextPrHandler(h)({ proposalId: "prp_1" }, API_KEY_CTX),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createDismissProposalHandler(h)(
        { proposalId: "prp_1", reason: "x" },
        API_KEY_CTX,
      ),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createProposeRecordHandler(h)(
        contextProposalCreate.input.parse({
          record: { ...record, kind: "rule", force: "should" },
          rationale: "14 unsatisfied runs in 30 days.",
        }),
        API_KEY_CTX,
      ),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createAppendRecordHandler(h)(
        contextRecordsAppend.input.parse({
          ...record,
          kind: "observation",
          sourceRefs: ["frame:run_1/12"],
        }),
        API_KEY_CTX,
      ),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    expect(h.github.branches).toHaveLength(0);
    expect(h.store.proposals).toHaveLength(0);
    expect(h.store.appends).toHaveLength(0);
  });
});
