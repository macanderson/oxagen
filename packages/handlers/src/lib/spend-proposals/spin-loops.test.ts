import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { describe, expect, it } from "vitest";
import { agentLineage, proposalSource } from "./shared";
import { spinLoopProposals } from "./spin-loops";
import { spinDraft } from "./test-support";

const AGENT = "acme.core.triage";

function build(...findings: FindingDraft[]) {
  return spinLoopProposals.build({ instructions: [], findings });
}

describe("spinLoopProposals", () => {
  it("opens one wait proposal per agent, with its runs as evidence", () => {
    const proposals = build(
      spinDraft(AGENT),
      spinDraft("acme.core.review", { citedRuns: ["tse_c"] }),
    );
    expect(proposals).toHaveLength(2);
    const [triage, review] = proposals;
    expect(triage).toMatchObject({
      kind: "spin_loops",
      lineageId: agentLineage("spin_loops", AGENT),
      title: `Wait rule for ${AGENT}`,
      runs: ["tse_a", "tse_b"],
      agents: [AGENT],
    });
    expect(review!.runs).toEqual(["tse_c"]);
    expect(review!.agents).toEqual(["acme.core.review"]);
    expect(review!.lineageId).not.toBe(triage!.lineageId);
  });

  it("tells the agent to wait with the harness and stop polling", () => {
    const [proposal] = build(spinDraft(AGENT));
    expect(proposal!.statement).toBe(
      `When you run as ${AGENT} and wait on another run or a subagent, use the harness's own wait or the subagent's result instead of polling in a shell loop.`,
    );
  });

  it("gives the finding's figures in the rationale", () => {
    const [proposal] = build(spinDraft(AGENT));
    expect(proposal!.rationale).toBe(
      `${AGENT} ran in a spin loop between 2026-09-01 and 2026-10-01. ` +
        "On 2 runs, a call ran 20 or more times in a row and returned the same result each time. 140 turns made only those repeats. " +
        "Those turns cost $12.40. " +
        "Each poll in a shell loop costs a full request. The harness's own wait and a subagent's result return once, when the work is done.",
    );
  });

  it("prices only the turns a price covers", () => {
    const draft = spinDraft(AGENT);
    const [proposal] = build({
      ...draft,
      evidence: { ...draft.evidence, coveredCalls: 100 },
    });
    expect(proposal!.rationale).toContain(
      "100 turns of them have a price, and those cost $12.40.",
    );
  });

  it("links the first call of each run on the run's own chain", () => {
    // tse_b looped on a subagent's chain, which a frame link cannot name.
    const [proposal] = build(spinDraft(AGENT));
    expect(proposal!.evidenceLinks).toEqual(["frame:tse_a/12"]);
  });

  it("links no frame when the finding pins none", () => {
    const draft = spinDraft(AGENT);
    const evidence = { ...draft.evidence };
    delete evidence.frames;
    const [proposal] = build({ ...draft, evidence });
    expect(proposal!.evidenceLinks).toEqual([]);
    expect(proposal!.runs).toEqual(["tse_a", "tse_b"]);
  });

  it("keeps the runs and links within the contract's caps", () => {
    const runs = Array.from({ length: 600 }, (_, i) => `tse_${i}`);
    const frames = Object.fromEntries(
      runs.map((runId) => [runId, { seqs: [{ seq: "1" }], total: 1 }]),
    );
    const draft = spinDraft(AGENT);
    const [proposal] = build({
      ...draft,
      citedRuns: runs,
      evidence: { ...draft.evidence, frames },
    });
    expect(proposal!.runs).toHaveLength(500);
    expect(proposal!.evidenceLinks).toHaveLength(100);
    expect(proposal!.evidenceLinks[0]).toBe("frame:tse_0/1");
  });

  it("reads only spin loop findings on an agent", () => {
    const proposals = build(
      spinDraft("prn_0123456789abcdefghjkmn", { level: "operator" }),
      spinDraft(AGENT, { kind: "duplicate_tool_calls" }),
    );
    expect(proposals).toEqual([]);
  });

  it("names the same lineage for the agent on every pass", () => {
    const [first] = build(spinDraft(AGENT));
    const [second] = build(spinDraft(AGENT, { citedRuns: ["tse_z"] }));
    expect(second!.lineageId).toBe(first!.lineageId);
    expect(first!.lineageId).toMatch(/^ctx\.spend\.spin-loops-[0-9a-f]{12}$/);
  });

  it("builds a proposal the propose_record contract accepts", () => {
    const [proposal] = build(spinDraft(AGENT));
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
      source: proposalSource("spin_loops"),
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
