// The role-gated steering writes act as the signed-in user or, for an API-key
// call, the key's creator (`resolveActingUserId`; apps/app/ARCHITECTURE.md §9,
// 2026-09-15). This file runs the real gate with only the key lookup
// replaced by a key whose row names no creator: `assertOrgRole` refuses it
// with `no_principal` before any store or GitHub call. `merge_steering_pr`
// keeps its own reviewer gate, which needs a signed-in user, so a key is
// refused there too.
import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam/org-role")>()),
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
}));

import { steeringPrMerge } from "@oxagen/oxagen/contracts/steering.pr.merge";
import { steeringPrOpen } from "@oxagen/oxagen/contracts/steering.pr.open";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { steeringProposalDismiss } from "@oxagen/oxagen/contracts/steering.proposal.dismiss";
import { steeringRecordsAppend } from "@oxagen/oxagen/contracts/steering.records.append";
import { createMergeSteeringPrHandler } from "./steering.pr.merge";
import { createOpenSteeringPrHandler } from "./steering.pr.open";
import { createProposeRecordHandler } from "./steering.proposal.create";
import { createDismissProposalHandler } from "./steering.proposal.dismiss";
import { createAppendRecordHandler } from "./steering.records.append";
import { ctx, harness } from "./context.steering.test-support";

const API_KEY_CTX = ctx({ userId: null, apiKeyId: "key_1" });
const NO_PRINCIPAL = { code: "forbidden", reason: "no_principal" };

describe("the role-gated steering writes under an API key with no creator", () => {
  // An API key reaches these writes only through the api surface: none is on
  // MCP or the CLI. Stella calls them on the agent surface as the signed-in
  // person, so the role gate has a principal there (#4180).
  it("declare no MCP or CLI surface for the PR writes", () => {
    for (const contract of [
      steeringPrOpen,
      steeringPrMerge,
      steeringProposalDismiss,
    ]) {
      expect(contract.surfaces, contract.name).toEqual(["api", "agent"]);
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
      createOpenSteeringPrHandler(h)({ proposalId: "prp_1" }, API_KEY_CTX),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createMergeSteeringPrHandler(h)({ proposalId: "prp_1" }, API_KEY_CTX),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createDismissProposalHandler(h)(
        { proposalId: "prp_1", reason: "x" },
        API_KEY_CTX,
      ),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createProposeRecordHandler(h)(
        steeringProposalCreate.input.parse({
          record: { ...record, kind: "rule", force: "should" },
          rationale: "14 unsatisfied runs in 30 days.",
        }),
        API_KEY_CTX,
      ),
    ).rejects.toMatchObject(NO_PRINCIPAL);
    await expect(
      createAppendRecordHandler(h)(
        steeringRecordsAppend.input.parse({
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
