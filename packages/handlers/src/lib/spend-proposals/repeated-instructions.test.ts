import { describe, expect, it } from "vitest";
import { repeatedInstructionProposals } from "./repeated-instructions";
import { instruction, spinDraft } from "./test-support";

describe("repeatedInstructionProposals", () => {
  it("passes each repeated instruction on as it is, with no title", () => {
    const proposals = repeatedInstructionProposals.build({
      instructions: [instruction(1), instruction(2)],
      findings: [],
    });
    expect(proposals).toEqual([
      { kind: "repeated_instructions", title: null, ...instruction(1) },
      { kind: "repeated_instructions", title: null, ...instruction(2) },
    ]);
  });

  it("builds nothing from findings alone", () => {
    expect(
      repeatedInstructionProposals.build({
        instructions: [],
        findings: [spinDraft("acme.core.triage")],
      }),
    ).toEqual([]);
  });
});
