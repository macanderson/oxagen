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
  reverts: { cohort: 3, reverted: 1, waiting: 4 },
  delivery: {
    sends: 7,
    claimed: 4,
    rejected: 1,
    withdrawn: 1,
    waiting: 1,
    claim_minutes: { median: 2, p90: 12.5, sample: 4 },
    truncated: false,
  },
  truncated: false,
  weeks: [
    { week: "2026-09-28", accepted_merged: 2, returned: 0, median_lead_hours: 5, entered: 6, sent: 3, full_flow: true, complete: true },
  ],
};

// get_work_outcomes (P1-05, #5163; the pilot measures, P1-06, #5241).
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
      delivery: {
        sends: 0,
        claimed: 0,
        rejected: 0,
        withdrawn: 0,
        waiting: 0,
        claim_minutes: { median: null, p90: null, sample: 0 },
        truncated: false,
      },
      weeks: [
        { week: "2026-09-28", accepted_merged: 0, returned: 0, median_lead_hours: null, entered: 0, sent: 0, full_flow: false, complete: false },
      ],
    };
    expect(contract.output.safeParse(empty).success).toBe(true);
  });

  it("refuses a week that is not a date, a negative count, or a rate it does not name", () => {
    expect(contract.output.safeParse({ ...OUTPUT, weeks: [{ ...OUTPUT.weeks[0], week: "2026-W40" }] }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, returned: -1 }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, acceptance_rate: 0.8 }).success).toBe(false);
  });

  it("refuses a negative delivery count, a week whose full flow is not a boolean, and a pilot verdict", () => {
    expect(contract.output.safeParse({ ...OUTPUT, delivery: { ...OUTPUT.delivery, waiting: -1 } }).success).toBe(false);
    expect(
      contract.output.safeParse({ ...OUTPUT, delivery: { ...OUTPUT.delivery, claim_minutes: { median: -1, p90: 2, sample: 1 } } }).success,
    ).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, weeks: [{ ...OUTPUT.weeks[0], full_flow: 1 }] }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, weeks: [{ ...OUTPUT.weeks[0], full_flow: "yes" }] }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, delivery: { ...OUTPUT.delivery, claim_rate: 0.6 } }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, pilot_passed: true }).success).toBe(false);
  });

  it("says whether the window covers each whole week, and refuses a week that does not say", () => {
    const unsaid = { week: "2026-09-28", accepted_merged: 2, returned: 0, median_lead_hours: 5, entered: 6, sent: 3, full_flow: true };
    expect(contract.output.safeParse({ ...OUTPUT, weeks: [unsaid] }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, weeks: [{ ...OUTPUT.weeks[0], complete: "partly" }] }).success).toBe(false);
    expect(contract.output.parse({ ...OUTPUT, weeks: [{ ...OUTPUT.weeks[0], complete: false }] }).weeks[0]?.complete).toBe(false);
  });

  // #5244: reverts over the reopen cohort, with the items that wait to count.
  it("answers reverts beside reopens and refuses a negative count or a revert rate", () => {
    expect(contract.output.parse(OUTPUT).reverts).toEqual({ cohort: 3, reverted: 1, waiting: 4 });
    expect(contract.output.safeParse({ ...OUTPUT, reverts: { ...OUTPUT.reverts, reverted: -1 } }).success).toBe(false);
    expect(contract.output.safeParse({ ...OUTPUT, reverts: { ...OUTPUT.reverts, rate: 0.33 } }).success).toBe(false);
    const { reverts: _reverts, ...withoutReverts } = OUTPUT;
    expect(contract.output.safeParse(withoutReverts).success).toBe(false);
  });
});
