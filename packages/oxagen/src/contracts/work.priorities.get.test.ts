import { describe, expect, it } from "vitest";
import { workPrioritiesGet as contract } from "./work.priorities.get";

// get_work_priorities (P1-03, #5103).
describe("get_work_priorities contract", () => {
  const counts = { suggestions: 12, failures: 1, corrections: 2 };

  it("answers the record triage reads, with its rules", () => {
    expect(
      contract.output.safeParse({
        record: {
          lineage: "aintel.work.priorities",
          record_id: "ctr_01",
          version: 7,
          hash: `sha256:${"a".repeat(64)}`,
          rules: [{ number: 1, text: "A security hole is P0." }],
          published_at: "2026-10-01T10:00:00.000Z",
        },
        problem: null,
        last_30_days: counts,
      }).success,
    ).toBe(true);
  });

  it("answers no record with the problem to fix", () => {
    expect(contract.output.safeParse({ record: null, problem: "No priorities record.", last_30_days: counts }).success).toBe(true);
    expect(
      contract.output.safeParse({
        record: { lineage: "x", record_id: "ctr_01", version: 1, hash: "md5:abc", rules: [], published_at: null },
        problem: null,
        last_30_days: counts,
      }).success,
    ).toBe(false);
  });

  it("reads only, and lets a workspace viewer read", () => {
    expect(contract.input.parse({})).toEqual({});
    expect(contract.mutates).not.toBe(true);
    expect(contract.defaultRoles?.workspace?.Viewer).toBe("allow");
  });
});
