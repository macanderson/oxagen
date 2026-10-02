import { describe, expect, it } from "vitest";
import { workOutcomesGet as contract } from "./work.outcomes.get";

const OUTPUT = {
  days: 30,
  since: "2026-09-02T00:00:00.000Z",
  accepted_merged: 4,
  returned: 1,
  closed: { cancelled: 0, declined: 1, duplicate: 2 },
  lead_time: { median_hours: 6.5, p90_hours: 30, sample: 4 },
  touches: { per_item: 2.5, brief_approvals: 4, acceptances: 4, returns: 1, triage_overrides: 0, triage_corrections: 1 },
  cost: { runs: 5, known_runs: 4, total: { micros: "12000000", currency: "USD" } },
  reopens: { cohort: 3, reopened: 1, waiting: 4 },
  truncated: false,
  weeks: [{ week: "2026-09-28", accepted_merged: 2, returned: 0, median_lead_hours: 5 }],
};

// get_work_outcomes (P1-05, #5163).
describe("get_work_outcomes contract", () => {
  it("registers a read on the API surface that never meters", () => {
    expect(contract.name).toBe("get_work_outcomes");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.scoped).toBe(true);
    expect(contract.mutates).toBe(false);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("reads a window of 7 to 90 days, 30 by default", () => {
    expect(contract.input.parse({})).toEqual({ days: 30 });
    expect(contract.input.parse({ days: 7 })).toEqual({ days: 7 });
    expect(contract.input.safeParse({ days: 6 }).success).toBe(false);
    expect(contract.input.safeParse({ days: 91 }).success).toBe(false);
  });

  it("answers the counts apart, with no rate where there is no sample", () => {
    expect(contract.output.parse(OUTPUT)).toEqual(OUTPUT);
    const empty = {
      ...OUTPUT,
      accepted_merged: 0,
      lead_time: { median_hours: null, p90_hours: null, sample: 0 },
      touches: { ...OUTPUT.touches, per_item: null },
      cost: { runs: 0, known_runs: 0, total: null },
      weeks: [{ week: "2026-09-28", accepted_merged: 0, returned: 0, median_lead_hours: null }],
    };
    expect(contract.output.safeParse(empty).success).toBe(true);
  });

  it("refuses a week that is not a date, a negative count, or a rate it does not name", () => {
    expect(contract.output.safeParse({ ...OUTPUT, weeks: [{ ...OUTPUT.weeks[0], week: "2026-W40" }] }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, returned: -1 }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, acceptance_rate: 0.8 }).success).toBe(false);
  });
});
