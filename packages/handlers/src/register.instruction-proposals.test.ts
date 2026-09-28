// Loading the handler registrations installs the opener the findings pass
// calls to open a steering record proposal for each repeated instruction
// (detector 6, prompt habits). @oxagen/billing cannot import the proposal
// path itself: this package depends on it.
import {
  instructionProposalOpener,
  type InstructionProposal,
} from "@oxagen/billing/proposal-opener";
import { getScope } from "@oxagen/tenancy";
import { describe, expect, it, vi } from "vitest";

const { openFor } = vi.hoisted(() => ({
  openFor: vi.fn(),
}));
vi.mock("./lib/instruction-proposals", () => ({
  openInstructionProposalsFor: openFor,
}));

await import("./register");

const scope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

const proposal: InstructionProposal = {
  lineageId: "ctx.habits.instruction-0123456789ab",
  statement: "Run the unit tests before you open a pull request.",
  rationale: "Runs received it 3 times.",
  runs: ["run_a", "run_b", "run_c"],
  agents: [],
  evidenceLinks: ["frame:run_a/1"],
};

describe("the handler registrations", () => {
  it("install the steering record proposal opener", () => {
    expect(instructionProposalOpener()).not.toBeNull();
  });

  it("open proposals inside the workspace's tenant scope", async () => {
    let seen: unknown = null;
    openFor.mockImplementation(async () => {
      seen = getScope();
      return { opened: 1, taken: 0 };
    });
    await instructionProposalOpener()!(scope, [proposal]);
    expect(openFor).toHaveBeenCalledWith(scope, [proposal]);
    expect(seen).toMatchObject(scope);
  });
});
