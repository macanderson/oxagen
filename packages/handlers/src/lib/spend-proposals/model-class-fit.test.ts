import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { describe, expect, it } from "vitest";
import { modelClassFitProposals, READ_ONLY_EFFORT } from "./model-class-fit";
import { agentLineage, proposalSource } from "./shared";
import { classDraft } from "./test-support";

const AGENT = "acme.core.research";

function build(...findings: FindingDraft[]) {
  return modelClassFitProposals.build({ instructions: [], findings });
}

describe("modelClassFitProposals", () => {
  it("opens one model route proposal per agent, with its runs as evidence", () => {
    const proposals = build(
      classDraft(AGENT),
      classDraft("acme.core.review", { citedRuns: ["tse_r9"] }),
    );
    expect(proposals).toHaveLength(2);
    const [research, review] = proposals;
    expect(research).toMatchObject({
      kind: "model_class_fit",
      lineageId: agentLineage("model_class_fit", AGENT),
      title: `Model route for ${AGENT}`,
      runs: ["tse_r1", "tse_r2", "tse_r3"],
      agents: [AGENT],
    });
    expect(review!.runs).toEqual(["tse_r9"]);
    expect(review!.agents).toEqual(["acme.core.review"]);
    expect(review!.lineageId).not.toBe(research!.lineageId);
  });

  it("states the route and the effort for the steps that only read", () => {
    const [proposal] = build(classDraft(AGENT));
    expect(READ_ONLY_EFFORT).toBe("low");
    expect(proposal!.statement).toBe(
      `When you run as ${AGENT}, run each step that only reads, such as a search or a file read, in a subagent one model class smaller than yours, such as Sonnet in place of Opus, at low effort.`,
    );
  });

  it("gives the finding's figures in the rationale and calls the saving an estimate", () => {
    const [proposal] = build(classDraft(AGENT));
    expect(proposal!.rationale).toBe(
      `${AGENT} ran steps that only read between 2026-09-01 and 2026-10-01. ` +
        "3 runs changed no file. Repriced from claude-opus-5 to claude-sonnet-5 at list prices, they would have cost an estimated 31% less. " +
        "The estimated saving is $2.79. " +
        "The saving stays an estimate until a replay on the smaller class confirms it.",
    );
  });

  it("carries the step split the finding reports for runs with edit steps", () => {
    const why =
      "2 runs with edit steps also had steps that only read. Repriced from claude-opus-5 to claude-sonnet-5 at list prices, those steps would have cost an estimated 40% less.";
    const [proposal] = build(classDraft(AGENT, { why }));
    expect(proposal!.rationale).toContain(why);
  });

  it("prices only the runs a price covers", () => {
    const draft = classDraft(AGENT);
    const [proposal] = build({
      ...draft,
      evidence: { ...draft.evidence, coveredCalls: 2 },
    });
    expect(proposal!.rationale).toContain(
      "2 runs of them have a price, and their estimated saving is $2.79.",
    );
  });

  it("links no frame, since the finding cites whole runs", () => {
    const [proposal] = build(classDraft(AGENT));
    expect(proposal!.evidenceLinks).toEqual([]);
  });

  it("keeps the runs within the contract's cap", () => {
    const runs = Array.from({ length: 600 }, (_, i) => `tse_${i}`);
    const [proposal] = build(classDraft(AGENT, { citedRuns: runs }));
    expect(proposal!.runs).toHaveLength(500);
    expect(proposal!.runs[0]).toBe("tse_0");
  });

  it("reads only model class fit findings on an agent", () => {
    const proposals = build(
      classDraft("prn_0123456789abcdefghjkmn", { level: "operator" }),
      classDraft(AGENT, { kind: "spin_loops" }),
    );
    expect(proposals).toEqual([]);
  });

  it("names the same lineage for the agent on every pass", () => {
    const [first] = build(classDraft(AGENT));
    const [second] = build(classDraft(AGENT, { citedRuns: ["tse_r7"] }));
    expect(second!.lineageId).toBe(first!.lineageId);
    expect(first!.lineageId).toMatch(
      /^ctx\.spend\.model-class-fit-[0-9a-f]{12}$/,
    );
  });

  it("builds a proposal the propose_record contract accepts", () => {
    const [proposal] = build(classDraft(AGENT));
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
      source: proposalSource("model_class_fit"),
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
