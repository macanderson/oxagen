import { describe, expect, it } from "vitest";
import { workCollectorSync as contract } from "./work.collector.sync";

// sync_work_collector (P1-03, #5103).
describe("sync_work_collector contract", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("takes a collector id or a collector name", () => {
    expect(contract.input.parse({ collector_id: id })).toEqual({ collector_id: id });
    expect(contract.input.safeParse({ collector_id: "github" }).success).toBe(false);
    expect(contract.input.parse({ name: "github" })).toEqual({ name: "github" });
    expect(contract.input.safeParse({ name: "" }).success).toBe(false);
  });

  it("answers that the reconcile was queued", () => {
    expect(contract.output.safeParse({ collector_id: id, queued: true }).success).toBe(true);
  });

  it("writes and stays off the agent surface", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.surfaces).not.toContain("agent");
  });

  // A sync changes a collector, so only a signed-in person runs it (#5181,
  // ADR-250 amended 2026-10-03). The handler refuses every key, so no MCP tool.
  it("is on the API surface only, like set_work_collector", () => {
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.layers).not.toContain("mcp");
  });
});
