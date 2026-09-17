import { describe, expect, it } from "vitest";
import { contextProposalCreate } from "./context.proposal.create";

const record = {
  lineageId: "ctx.platform.migration-order",
  kind: "constraint",
  force: "must",
  constraintEffect: "forbid",
  sharingScope: "workspace",
  statement: "Never renumber a merged migration.",
};

describe("propose_record contract", () => {
  it("is a write on the agent surface that steers nothing: unmetered, no approval", () => {
    expect(contextProposalCreate.name).toBe("propose_record");
    expect(contextProposalCreate.surfaces).toContain("agent");
    expect(contextProposalCreate.mutates).toBe(true);
    expect(contextProposalCreate.noBillingGate).toBe(true);
    expect(contextProposalCreate.agent?.requiresApproval).toBe(false);
  });

  it("takes the proposed record, a rationale and optional support with empty defaults", () => {
    const parsed = contextProposalCreate.input.parse({
      record,
      rationale: "Three data-layer drift findings.",
    });
    expect(parsed.support).toEqual({
      runs: [],
      agents: [],
      recordIds: [],
      evidenceLinks: [],
    });
    expect(parsed.source).toBeUndefined();
    expect(
      contextProposalCreate.input.safeParse({ record, rationale: "" }).success,
    ).toBe(false);
    expect(
      contextProposalCreate.input.safeParse({
        record: { ...record, constraintEffect: "allow" },
        rationale: "x",
      }).success,
    ).toBe(false);
  });

  it("answers the proposal in the proposed state", () => {
    expect(
      contextProposalCreate.output.safeParse({
        proposalId: "prp_1",
        lineageId: record.lineageId,
        status: "pr_open",
      }).success,
    ).toBe(false);
  });
});
