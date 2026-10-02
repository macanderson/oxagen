import { describe, expect, it } from "vitest";
import { steeringProposalCreate } from "./steering.proposal.create";

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
    expect(steeringProposalCreate.name).toBe("propose_record");
    expect(steeringProposalCreate.surfaces).toContain("agent");
    expect(steeringProposalCreate.mutates).toBe(true);
    expect(steeringProposalCreate.noBillingGate).toBe(true);
    expect(steeringProposalCreate.agent?.requiresApproval).toBe(false);
  });

  it("takes the proposed record, a rationale and optional support with empty defaults", () => {
    const parsed = steeringProposalCreate.input.parse({
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
      steeringProposalCreate.input.safeParse({ record, rationale: "" }).success,
    ).toBe(false);
    expect(
      steeringProposalCreate.input.safeParse({
        record: { ...record, constraintEffect: "allow" },
        rationale: "x",
      }).success,
    ).toBe(false);
  });

  it("answers the proposal in the proposed state", () => {
    expect(
      steeringProposalCreate.output.safeParse({
        proposalId: "prp_1",
        lineageId: record.lineageId,
        status: "pr_open",
      }).success,
    ).toBe(false);
  });
});
