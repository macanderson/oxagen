import { describe, expect, it } from "vitest";
import { BACKING, allMethods, backingOf, notBackedFor } from "./backing";
import { NO_GAP } from "./not-backed";
import { PAGE_KEYS } from "./page-states";

const GAPS = new Set([
  NO_GAP,
  ...Array.from({ length: 15 }, (_, i) => `G${String(i + 1)}`),
]);

describe("the backing table (plan §3 as data)", () => {
  it.each(allMethods())(
    "$port.$method names a page, a lane and a §3.4 gap",
    ({ backing }) => {
      expect(PAGE_KEYS).toContain(backing.page);
      expect(backing.lane).toMatch(/^A([1-9]|10)$/);
      expect(GAPS.has(backing.gap)).toBe(true);
    },
  );

  it("marks a store that exists today as M0 with no gap", () => {
    for (const { backing } of allMethods().filter(
      (m) => m.backing.store === "backed",
    )) {
      expect(backing).toMatchObject({ milestone: "M0", gap: NO_GAP });
    }
  });

  it("never calls a missing store M0: it waits on a real milestone (negative)", () => {
    for (const { backing } of allMethods().filter(
      (m) => m.backing.store === "none",
    )) {
      expect(backing.milestone).not.toBe("M0");
    }
  });

  it("carries the §3.4 gaps the plan names for them", () => {
    expect(BACKING.runs.listRuns).toMatchObject({ milestone: "M2", gap: "G3" });
    expect(BACKING.agents.getMandate).toMatchObject({
      milestone: "M2",
      gap: "G1",
      page: "mandate",
    });
    expect(BACKING.agents.scores).toMatchObject({
      milestone: "spec-decision",
      gap: "G11",
    });
    expect(BACKING.tools.autoApprovalRules.gap).toBe("G12");
    expect(BACKING.spend.reconciliation).toMatchObject({
      milestone: "M5",
      gap: "G5",
    });
    expect(BACKING.billing.allowance.gap).toBe("G13");
    expect(BACKING.audit.holds.gap).toBe("G8");
    expect(BACKING.runs.proof).toMatchObject({ milestone: "M6", gap: "G7" });
  });

  it("builds the not-backed read from the table", () => {
    expect(backingOf("runs", "contextWindow").gap).toBe("G10");
    expect(notBackedFor("runs", "contextWindow")).toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M3",
      gap: "G10",
    });
  });
});
