import type { FindingDraft } from "@oxagen/billing/proposal-opener";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { describe, expect, it } from "vitest";
import { proposalSource, subjectLineage } from "./shared";
import { unpagedDraft } from "./test-support";
import { COMPACT_AT_TOKENS, unpagedResultProposals } from "./unpaged-results";

const TOOL = "mcp__docs__search";

function build(...findings: FindingDraft[]) {
  return unpagedResultProposals.build({ instructions: [], findings });
}

describe("unpagedResultProposals", () => {
  it("opens one context proposal per tool, with its runs as evidence", () => {
    const proposals = build(
      unpagedDraft(TOOL),
      unpagedDraft("mcp__issues__list", { citedRuns: ["tse_e"] }),
    );
    expect(proposals).toHaveLength(2);
    const [search, list] = proposals;
    expect(search).toMatchObject({
      kind: "unpaged_results",
      lineageId: subjectLineage("unpaged_results", TOOL),
      title: `Context rule for ${TOOL}`,
      runs: ["tse_c", "tse_d"],
      agents: [],
    });
    expect(list!.runs).toEqual(["tse_e"]);
    expect(list!.lineageId).not.toBe(search!.lineageId);
  });

  it("proposes a fresh subagent and compaction past 150,000 tokens", () => {
    const [proposal] = build(unpagedDraft(TOOL));
    expect(COMPACT_AT_TOKENS).toBe(150_000);
    expect(proposal!.statement).toBe(
      `When a step calls ${TOOL} for a large result it needs only once, run that step in a fresh subagent, and compact your context as soon as it stays over 150,000 tokens.`,
    );
  });

  it("gives the finding's figures in the rationale", () => {
    const [proposal] = build(unpagedDraft(TOOL));
    expect(proposal!.rationale).toBe(
      `Runs called ${TOOL} between 2026-09-01 and 2026-10-01. ` +
        `${TOOL} returned 4 results over 5,000 tokens on 2 runs. Later requests read them 60 times. ` +
        "Those reads cost $1.08 more than reading one page of each result would have. " +
        "A result stays in the context until the run compacts, so every later request reads it again. A fresh subagent keeps a large result out of the run's own context, and an earlier compaction ends the reads sooner.",
    );
  });

  it("prices only the reads a price covers", () => {
    const draft = unpagedDraft(TOOL);
    const [proposal] = build({
      ...draft,
      evidence: { ...draft.evidence, coveredCalls: 40 },
    });
    expect(proposal!.rationale).toContain(
      "40 reads of them have a price, and those cost $1.08 more than reading one page of each result would have.",
    );
  });

  it("links the first large result of each run on the run's own chain", () => {
    // tse_d carried its result on a subagent's chain, which a frame link
    // cannot name.
    const [proposal] = build(unpagedDraft(TOOL));
    expect(proposal!.evidenceLinks).toEqual(["frame:tse_c/7"]);
  });

  it("reads only unpaged result findings on a tool", () => {
    const proposals = build(
      unpagedDraft(TOOL, { level: "agent" }),
      unpagedDraft(TOOL, { kind: "duplicate_tool_calls" }),
    );
    expect(proposals).toEqual([]);
  });

  it("names the same lineage for the tool on every pass", () => {
    const [first] = build(unpagedDraft(TOOL));
    const [second] = build(unpagedDraft(TOOL, { citedRuns: ["tse_z"] }));
    expect(second!.lineageId).toBe(first!.lineageId);
    expect(first!.lineageId).toMatch(
      /^ctx\.spend\.unpaged-results-[0-9a-f]{12}$/,
    );
  });

  it("builds a proposal the propose_record contract accepts", () => {
    const [proposal] = build(unpagedDraft(TOOL));
    const parsed = steeringProposalCreate.input.safeParse({
      record: {
        lineageId: proposal!.lineageId,
        title: proposal!.title,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement: proposal!.statement,
      },
      rationale: proposal!.rationale,
      source: proposalSource("unpaged_results"),
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
