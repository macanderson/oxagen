import { describe, expect, it } from "vitest";
import { workTriageRetry as contract } from "./work.triage.retry";

// retry_work_triage (P1-03, #5103).
describe("retry_work_triage contract", () => {
  it("takes a work item id", () => {
    expect(contract.input.parse({ item_id: "wi_01" })).toEqual({ item_id: "wi_01" });
    expect(contract.input.safeParse({ item_id: "tri_01" }).success).toBe(false);
    expect(contract.input.safeParse({ item_id: "wi_01", force: true }).success).toBe(false);
  });

  it("answers that the run was queued", () => {
    expect(contract.output.safeParse({ item_id: "wi_01", state: "new", queued: true }).success).toBe(true);
    expect(contract.output.safeParse({ item_id: "wi_01", state: "new", queued: false }).success).toBe(false);
  });

  it("writes and charges no credits itself", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.noBillingGate).toBe(true);
  });

  // Each retry is a model call the organization pays for, so only a signed-in
  // person asks for one (ADR-250 amended 2026-10-03). The handler refuses
  // every key, so no MCP tool.
  it("is on the API surface only", () => {
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.layers).not.toContain("mcp");
  });
});
