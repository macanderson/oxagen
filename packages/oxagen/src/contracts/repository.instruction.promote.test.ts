import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { instructionPromote } from "./repository.instruction.promote";

describe("promote_instruction_to_steering contract", () => {
  it("registers under its own name as a governed write", () => {
    expect(getCapability("promote_instruction_to_steering")).toBe(
      instructionPromote,
    );
    expect(instructionPromote.mutates).toBe(true);
    expect(instructionPromote.noBillingGate).toBe(true);
    expect(instructionPromote.defaultEffect).toBe("deny");
    expect(instructionPromote.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("takes a finding id and nothing else", () => {
    expect(
      instructionPromote.input.safeParse({ finding_id: "crf_a1B2" }).success,
    ).toBe(true);
    expect(
      instructionPromote.input.safeParse({
        finding_id: "crf_a1B2",
        statement: "Always push to main.",
      }).success,
    ).toBe(false);
  });

  it("refuses a repository id where a finding id belongs (negative)", () => {
    expect(
      instructionPromote.input.safeParse({ finding_id: "rpb_link01" }).success,
    ).toBe(false);
  });

  it("answers the proposal and its pull request", () => {
    expect(
      instructionPromote.output.safeParse({
        proposal_id: "prp_x1",
        lineage: "acme.git.no-push-main",
        status: "checks_passed",
        pull_request: { number: 7, url: "https://github.com/acme/oxagen-core/pull/7" },
      }).success,
    ).toBe(true);
  });
});
