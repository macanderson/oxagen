import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { describe, expect, it } from "vitest";
import { recurringRunProposals } from "./recurring-runs";
import { agentLineage, proposalSource } from "./shared";
import { recurringDraft } from "./test-support";

const AGENT = "acme.core.nightly";

function build(...findings: FindingDraft[]) {
  return recurringRunProposals.build({ instructions: [], findings });
}

describe("recurringRunProposals", () => {
  it("opens one schedule proposal per agent, with its runs as evidence", () => {
    const proposals = build(
      recurringDraft(AGENT),
      recurringDraft("acme.core.digest", { citedRuns: ["tse_k1"] }),
    );
    expect(proposals).toHaveLength(2);
    const [nightly, digest] = proposals;
    expect(nightly).toMatchObject({
      kind: "recurring_runs",
      lineageId: agentLineage("recurring_runs", AGENT),
      title: `Schedule rule for ${AGENT}`,
      runs: ["tse_j1", "tse_j2", "tse_j3"],
      agents: [AGENT],
    });
    expect(digest!.runs).toEqual(["tse_k1"]);
    expect(digest!.agents).toEqual(["acme.core.digest"]);
    expect(digest!.lineageId).not.toBe(nightly!.lineageId);
  });

  it("proposes a start on a change, a lower frequency, or a smaller class", () => {
    const [proposal] = build(recurringDraft(AGENT));
    expect(proposal!.statement).toBe(
      `Start a recurring job that runs as ${AGENT} when something changes, such as a new commit or a new issue, instead of on a clock, or run it less often or on a smaller model class.`,
    );
  });

  it("gives the finding's figures in the rationale", () => {
    const [proposal] = build(recurringDraft(AGENT));
    expect(proposal!.rationale).toBe(
      `${AGENT} started runs with a repeated prompt between 2026-09-01 and 2026-10-01. ` +
        "5 runs started with the same prompt in the last 30 days. 3 of them changed nothing. A run changed nothing when it made no mutating call and changed no file. " +
        "The runs that changed nothing cost $3.20. " +
        "A run that finds nothing to do still pays to find that out.",
    );
  });

  it("names the priced turns when some turns have no price", () => {
    const draft = recurringDraft(AGENT);
    const [proposal] = build({
      ...draft,
      evidence: { ...draft.evidence, coveredCalls: 16 },
    });
    expect(proposal!.rationale).toContain(
      "The turns with a price in the runs that changed nothing cost $3.20.",
    );
  });

  it("links no frame, since the finding cites whole runs", () => {
    const [proposal] = build(recurringDraft(AGENT));
    expect(proposal!.evidenceLinks).toEqual([]);
  });

  it("reads only recurring run findings on an agent", () => {
    const proposals = build(
      recurringDraft("prn_0123456789abcdefghjkmn", { level: "operator" }),
      recurringDraft("0192d4a8-7c1e-7a00-8000-0000000c0e01", {
        level: "workspace",
      }),
      recurringDraft(AGENT, { kind: "spend_with_no_outcome" }),
    );
    expect(proposals).toEqual([]);
  });

  it("names the same lineage for the agent on every pass", () => {
    const [first] = build(recurringDraft(AGENT));
    const [second] = build(recurringDraft(AGENT, { citedRuns: ["tse_j9"] }));
    expect(second!.lineageId).toBe(first!.lineageId);
    expect(first!.lineageId).toMatch(
      /^ctx\.spend\.recurring-runs-[0-9a-f]{12}$/,
    );
  });

  it("builds a proposal the propose_record contract accepts", () => {
    const [proposal] = build(recurringDraft(AGENT));
    const parsed = contextProposalCreate.input.safeParse({
      record: {
        lineageId: proposal!.lineageId,
        title: proposal!.title,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: proposal!.statement,
      },
      rationale: proposal!.rationale,
      source: proposalSource("recurring_runs"),
      support: {
        runs: proposal!.runs,
        agents: proposal!.agents,
        evidenceLinks: proposal!.evidenceLinks,
      },
      createOnly: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("builds nothing from a pass with no findings", () => {
    expect(build()).toEqual([]);
  });
});
