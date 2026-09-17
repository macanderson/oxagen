import { describe, expect, it } from "vitest";
import { contextProposalList } from "./context.proposal.list";

describe("list_proposals contract", () => {
  it("is a console read", () => {
    expect(contextProposalList.name).toBe("list_proposals");
    expect(contextProposalList.mutates).toBe(false);
    expect(contextProposalList.noBillingGate).toBe(true);
  });

  it("filters by status and lineage and pages", () => {
    expect(contextProposalList.input.parse({})).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(
      contextProposalList.input.safeParse({ status: "candidate" }).success,
    ).toBe(false);
    expect(
      contextProposalList.input.safeParse({ status: "checks_passed" }).success,
    ).toBe(true);
  });

  it("answers each proposal with its support, its PR (or null) and its check tally (or null)", () => {
    const out = contextProposalList.output.parse({
      proposals: [
        {
          id: "prp_0123456789abcdefghjkmn",
          lineageId: "ctx.triage.reproduce-first",
          kind: "rule",
          force: "should",
          constraintEffect: null,
          sharingScope: "workspace",
          statement: "Reproduce before labelling.",
          rationale: "14 unsatisfied runs in 30 days.",
          source: "reflector · run_01K5RH3G8K5PAS7D",
          support: {
            runs: ["run_1"],
            agents: ["a.b.c"],
            recordIds: [],
            evidenceLinks: [],
          },
          status: "proposed",
          pr: null,
          checks: null,
          createdAt: "2026-09-15T00:00:00.000Z",
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      total: 1,
    });
    expect(out.proposals[0]?.pr).toBeNull();
  });
});
