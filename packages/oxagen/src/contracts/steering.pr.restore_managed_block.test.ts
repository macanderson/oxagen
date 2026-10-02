import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  steeringPrRestoreManagedBlock,
  MANAGED_BLOCK_PATHS,
} from "./steering.pr.restore_managed_block";

describe("restore_managed_block contract", () => {
  it("registers under its own name as a governed write", () => {
    expect(getCapability("restore_managed_block")).toBe(
      steeringPrRestoreManagedBlock,
    );
    expect(steeringPrRestoreManagedBlock.mutates).toBe(true);
    expect(steeringPrRestoreManagedBlock.noBillingGate).toBe(true);
    expect(steeringPrRestoreManagedBlock.defaultEffect).toBe("deny");
  });

  it("takes a proposal and one of the three managed files", () => {
    for (const path of MANAGED_BLOCK_PATHS) {
      expect(
        steeringPrRestoreManagedBlock.input.safeParse({
          proposalId: "prp_a1",
          path,
        }).success,
      ).toBe(true);
    }
  });

  it("refuses a file that holds no managed block (negative)", () => {
    expect(
      steeringPrRestoreManagedBlock.input.safeParse({
        proposalId: "prp_a1",
        path: "steering/constraints/acme.md",
      }).success,
    ).toBe(false);
    expect(
      steeringPrRestoreManagedBlock.input.safeParse({
        proposalId: "rpb_a1",
        path: "AGENTS.md",
      }).success,
    ).toBe(false);
  });
});
