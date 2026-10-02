import { describe, expect, it } from "vitest";
import { contextPrRefresh } from "./context.pr.refresh";

describe("refresh_context_pr contract", () => {
  it("is an unmetered write a workspace member makes without approval, off MCP", () => {
    expect(contextPrRefresh.name).toBe("refresh_context_pr");
    expect(contextPrRefresh.mutates).toBe(true);
    expect(contextPrRefresh.noBillingGate).toBe(true);
    expect(contextPrRefresh.agent?.requiresApproval).toBe(false);
    expect(contextPrRefresh.surfaces).toEqual(["api", "agent"]);
    expect(contextPrRefresh.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  it("takes only the proposal id", () => {
    expect(
      contextPrRefresh.input.safeParse({ proposalId: "prp_1" }).success,
    ).toBe(true);
    expect(
      contextPrRefresh.input.safeParse({ proposalId: "ctr_1" }).success,
    ).toBe(false);
  });

  it("answers the host's state, or none before a pull request opens", () => {
    expect(
      contextPrRefresh.output.safeParse({
        proposalId: "prp_1",
        status: "rejected",
        host: { state: "closed", headSha: "abc", baseRef: "main" },
        changed: true,
        syncRequested: false,
      }).success,
    ).toBe(true);
    expect(
      contextPrRefresh.output.safeParse({
        proposalId: "prp_1",
        status: "proposed",
        host: null,
        changed: false,
        syncRequested: false,
      }).success,
    ).toBe(true);
  });
});
