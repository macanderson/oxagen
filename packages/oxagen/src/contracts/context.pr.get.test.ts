import { describe, expect, it } from "vitest";
import { contextPrGet } from "./context.pr.get";
import { contextPrOpen } from "./context.pr.open";

describe("get_context_pr contract", () => {
  it("is the console read that polls the state machine, sharing open_context_pr's output", () => {
    expect(contextPrGet.name).toBe("get_context_pr");
    expect(contextPrGet.mutates).toBe(false);
    expect(contextPrGet.noBillingGate).toBe(true);
    expect(contextPrGet.output).toBe(contextPrOpen.output);
    expect(contextPrGet.input.safeParse({ proposalId: "prp_1" }).success).toBe(
      true,
    );
  });
});
