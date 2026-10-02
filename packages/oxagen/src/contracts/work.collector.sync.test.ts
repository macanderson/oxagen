import { describe, expect, it } from "vitest";
import { workCollectorSync as contract } from "./work.collector.sync";

// sync_work_collector (P1-03, #5103).
describe("sync_work_collector contract", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("takes a collector id", () => {
    expect(contract.input.parse({ collector_id: id })).toEqual({ collector_id: id });
    expect(contract.input.safeParse({ collector_id: "github" }).success).toBe(false);
  });

  it("answers that the reconcile was queued", () => {
    expect(contract.output.safeParse({ collector_id: id, queued: true }).success).toBe(true);
  });

  it("writes and stays off the agent surface", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.surfaces).not.toContain("agent");
  });
});
