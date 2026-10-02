import { describe, expect, it } from "vitest";
import { steeringPrGet } from "./steering.pr.get";
import { steeringPrOpen } from "./steering.pr.open";

describe("get_steering_pr contract", () => {
  it("is the console read that polls the state machine, sharing open_steering_pr's output", () => {
    expect(steeringPrGet.name).toBe("get_steering_pr");
    expect(steeringPrGet.mutates).toBe(false);
    expect(steeringPrGet.noBillingGate).toBe(true);
    expect(steeringPrGet.output).toBe(steeringPrOpen.output);
    expect(steeringPrGet.input.safeParse({ proposalId: "prp_1" }).success).toBe(
      true,
    );
  });
});
