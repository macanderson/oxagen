// The pure questions the mandate page asks of its record: which route it came
// by, which measure the tiles and the dialog speak for, what a figure looks like
// typed back into a field, and which rows one view of the ledger shows. The
// page's suite proves what is rendered; this one proves what is selected.
import { describe, expect, it } from "vitest";
import {
  callsAuthority,
  mandateAuthority,
  mandateDraw,
  mandateRow,
} from "@/test/mandate-views";
import {
  costOf,
  editableOf,
  isDrawn,
  lastDayOf,
  ledgerPage,
  MANDATE_ID,
  mandateLink,
  measuresOf,
  nextSort,
  openCalls,
  thresholdOf,
  unitOf,
  unitsOf,
  validDays,
  whenOf,
  zonedDay,
} from "./view";

describe("MANDATE_ID", () => {
  it("accepts the public-id shape the contract accepts", () => {
    expect(MANDATE_ID.test("mnd_4f2a9c")).toBe(true);
    expect(MANDATE_ID.test("mnd_7K2ETQ4")).toBe(true);
  });

  it("refuses anything that is not one (negative)", () => {
    for (const value of ["", "mnd_", "agt_4f2a9c", "not-a-mandate", "mnd 4f"]) {
      expect(MANDATE_ID.test(value)).toBe(false);
    }
  });
});

describe("mandateLink", () => {
  it("points at the flat route when the page came by it", () => {
    expect(
      mandateLink({
        org: "a-intel",
        ws: "finops",
        mandate: "mnd_1",
        agent: null,
      }),
    ).toBe("/a-intel/finops/mandates/mnd_1");
  });

  it("points at the design's route when the page came by that", () => {
    expect(
      mandateLink({
        org: "a-intel",
        ws: "finops",
        mandate: "mnd_1",
        agent: "invoice-bot",
      }),
    ).toBe("/a-intel/finops/agents/invoice-bot/mandates/mnd_1");
  });
});

describe("measuresOf", () => {
  it("speaks for the first measure that is not calls, and keeps the calls cap aside", () => {
    const amount = mandateAuthority();
    const calls = callsAuthority();
    const tax = mandateAuthority({ measure: "tax" });
    const split = measuresOf(mandateRow({ authority: [calls, amount, tax] }));
    expect(split.primary?.measure).toBe("amount");
    expect(split.calls?.measure).toBe("calls");
    expect(split.others.map((a) => a.measure)).toEqual(["tax"]);
  });

  it("speaks for calls when that is the only limit", () => {
    const split = measuresOf(mandateRow({ authority: [callsAuthority()] }));
    expect(split.primary?.measure).toBe("calls");
    expect(split.calls).toBeNull();
  });

  it("speaks for nothing on a mandate with no limit", () => {
    expect(measuresOf(mandateRow({ authority: [] })).primary).toBeNull();
  });
});

describe("units", () => {
  it("reads the unit from the record, never from a spelling", () => {
    expect(unitOf(mandateAuthority())).toBe("USD");
    expect(unitOf(callsAuthority())).toBe("calls");
  });

  it("lists each currency once and leaves the calls cap out", () => {
    expect(
      unitsOf(
        mandateRow({
          authority: [
            mandateAuthority(),
            mandateAuthority({ measure: "tax" }),
            callsAuthority(),
          ],
        }),
      ),
    ).toEqual(["USD"]);
  });

  it("tells a drawn figure from an undrawn one on the recorded digits", () => {
    expect(isDrawn({ kind: "count", count: "0", unit: "calls" })).toBe(false);
    expect(isDrawn({ kind: "count", count: "3", unit: "calls" })).toBe(true);
    expect(
      isDrawn({ kind: "money", money: { micros: "000", currency: "USD" } }),
    ).toBe(false);
  });
});

describe("editableOf", () => {
  it("writes micros as a decimal with at least two places and no grouping", () => {
    const money = (micros: string) =>
      ({ kind: "money", money: { micros, currency: "USD" } }) as const;
    expect(editableOf(money("250000000"))).toBe("250.00");
    expect(editableOf(money("5000000000"))).toBe("5000.00");
    expect(editableOf(money("5000"))).toBe("0.005");
    expect(editableOf(money("1250000"))).toBe("1.25");
    expect(editableOf(money("0"))).toBe("0.00");
  });

  it("writes a count as its digits, and nothing as blank", () => {
    expect(editableOf({ kind: "count", count: "50", unit: "calls" })).toBe(
      "50",
    );
    expect(editableOf(null)).toBe("");
  });
});

describe("thresholdOf", () => {
  it("finds the approval threshold the rule sets on a measure", () => {
    expect(thresholdOf(mandateRow(), "amount")?.recorded).toBe("100000000");
    expect(thresholdOf(mandateRow(), "calls")).toBeNull();
  });
});

describe("ledgerPage", () => {
  const ledger = [
    mandateDraw({ state: "reserve", externalEffectRef: null }),
    mandateDraw({ externalEffectRef: "pi_AAA" }),
    mandateDraw({ externalEffectRef: "pi_BBB" }),
    mandateDraw({ state: "release", externalEffectRef: null }),
    mandateDraw({ measure: "tax", externalEffectRef: "sp-1" }),
  ];
  const view = { search: "", state: null, size: 10, page: 0 } as const;

  it("shows every row on one page by default, with its range", () => {
    const page = ledgerPage(ledger, view);
    expect(page.rows).toHaveLength(5);
    expect([page.from, page.to, page.total, page.pages]).toEqual([1, 5, 5, 1]);
  });

  it("narrows to one state", () => {
    expect(ledgerPage(ledger, { ...view, state: "settle" }).rows).toHaveLength(
      3,
    );
  });

  it("matches the measure and the external id, case-insensitively", () => {
    expect(ledgerPage(ledger, { ...view, search: "PI_a" }).rows).toHaveLength(
      1,
    );
    expect(ledgerPage(ledger, { ...view, search: "tax" }).rows).toHaveLength(1);
  });

  it("pages by the chosen size and clamps a page past the end", () => {
    const page = ledgerPage(ledger, { ...view, size: 5, page: 0 });
    expect(page.pages).toBe(1);
    const second = ledgerPage(ledger, { ...view, size: 2, page: 2 });
    expect([second.from, second.to]).toEqual([5, 5]);
    const past = ledgerPage(ledger, { ...view, size: 2, page: 9 });
    expect(past.page).toBe(2);
  });

  it("shows every row when the size is All", () => {
    expect(ledgerPage(ledger, { ...view, size: 0 }).rows).toHaveLength(5);
  });

  it("reports an empty range when nothing matches", () => {
    const page = ledgerPage(ledger, { ...view, search: "zzz" });
    expect([page.from, page.to, page.total]).toEqual([0, 0, 0]);
  });
});

describe("openCalls", () => {
  const open = mandateDraw({ state: "reserve", externalEffectRef: null });
  it("counts the draws on a measure still holding a reservation", () => {
    expect(openCalls([open, mandateDraw()], "amount", null)).toBe(1);
    expect(openCalls([open, open], "amount", null)).toBe(2);
    expect(openCalls([open], "calls", null)).toBe(0);
  });

  it("claims no count when the read filled its bound (negative)", () => {
    expect(openCalls([open], "amount", 500)).toBeNull();
  });
});

describe("zonedDay and lastDayOf", () => {
  it("reads the day an instant falls on in the viewer's zone, not UTC", () => {
    expect(zonedDay("2026-09-01T02:00:00.000Z", "UTC")).toBe("2026-09-01");
    expect(zonedDay("2026-09-01T02:00:00.000Z", "America/New_York")).toBe(
      "2026-08-31",
    );
  });

  it("names the last day before an exclusive end", () => {
    expect(lastDayOf("2027-01-01T00:00:00.000Z", "UTC")).toBe("2026-12-31");
    expect(lastDayOf("2026-12-31T23:59:59.999Z", "UTC")).toBe("2026-12-31");
  });

  it("answers nothing for a zone this runtime cannot read (negative)", () => {
    expect(zonedDay("2026-09-01T00:00:00.000Z", "Mars/Olympus")).toBeNull();
  });
});

describe("validDays", () => {
  it("prints days when each end sits on a day boundary", () => {
    expect(
      validDays(
        {
          validFrom: "2026-09-01T00:00:00.000Z",
          validTo: "2026-12-31T23:59:59.999Z",
        },
        "UTC",
      ),
    ).toEqual({ from: "2026-09-01", to: "2026-12-31" });
  });

  // The window is half-open. A mandate that ends at 14:00 has not given the
  // rest of that day, so its end is not printed as a day.
  it("leaves an end inside a day to be printed with its time (negative)", () => {
    expect(
      validDays(
        {
          validFrom: "2026-09-01T09:30:00.000Z",
          validTo: "2026-12-31T14:00:00.000Z",
        },
        "UTC",
      ),
    ).toEqual({ from: null, to: null });
  });
});

describe("whenOf", () => {
  const asOf = "2026-09-11T12:00:00.000Z";
  it("prints the time for a draw on the day the ledger was read", () => {
    expect(whenOf("2026-09-11T09:31:08.000Z", asOf, "UTC")).toEqual({
      kind: "time",
      text: "09:31:08",
    });
  });

  it("prints the day for an older draw", () => {
    expect(whenOf("2026-09-04T08:40:19.000Z", asOf, "UTC")).toEqual({
      kind: "day",
      text: "2026-09-04",
    });
  });
});

describe("ledger sort", () => {
  const usd = (micros: string) =>
    ({ kind: "money", money: { micros, currency: "USD" } }) as const;
  const ledger = [
    mandateDraw({
      value: usd("900000000"),
      externalEffectRef: "pi_c",
      at: "2026-09-02T00:00:00.000Z",
    }),
    mandateDraw({
      state: "reserve",
      value: usd("100000000"),
      externalEffectRef: null,
      at: "2026-09-03T00:00:00.000Z",
    }),
    mandateDraw({
      state: "release",
      value: usd("50000000"),
      externalEffectRef: "pi_a",
      at: "2026-09-01T00:00:00.000Z",
    }),
    mandateDraw({
      measure: "calls",
      value: { kind: "count", count: "1", unit: "calls" },
      externalEffectRef: "pi_b",
      at: "2026-09-04T00:00:00.000Z",
    }),
  ];
  const view = { search: "", state: null, size: 10, page: 0 } as const;
  const refs = (sort: Parameters<typeof nextSort>[0]) =>
    ledgerPage(ledger, { ...view, sort }).rows.map((r) => r.externalEffectRef);

  it("keeps the server's order when nothing sorts", () => {
    expect(refs(null)).toEqual(["pi_c", null, "pi_a", "pi_b"]);
  });

  it("sorts amounts as integers within a measure, never across measures", () => {
    // "amount" before "calls"; 0 (the release cost nothing) < 100 < 900
    // dollars, by micros, not by text.
    expect(refs({ column: "amount", dir: 1 })).toEqual([
      "pi_a",
      null,
      "pi_c",
      "pi_b",
    ]);
  });

  it("sorts by time, by state in the order a draw moves, and by external id with the blank last", () => {
    expect(refs({ column: "when", dir: -1 })).toEqual([
      "pi_b",
      null,
      "pi_c",
      "pi_a",
    ]);
    expect(refs({ column: "state", dir: 1 })[0]).toBeNull();
    expect(refs({ column: "external", dir: 1 })).toEqual([
      "pi_a",
      "pi_b",
      "pi_c",
      null,
    ]);
  });

  it("cycles a header ascending, descending, then off, and starts a new column ascending", () => {
    const up = nextSort(null, "amount");
    expect(up).toEqual({ column: "amount", dir: 1 });
    const down = nextSort(up, "amount");
    expect(down).toEqual({ column: "amount", dir: -1 });
    expect(nextSort(down, "amount")).toBeNull();
    expect(nextSort(down, "when")).toEqual({ column: "when", dir: 1 });
  });
});

describe("costOf", () => {
  it("prints a released draw as zero in its own currency or unit, and every other draw as its value", () => {
    const usd = {
      kind: "money",
      money: { micros: "18000000", currency: "USD" },
    } as const;
    expect(costOf(mandateDraw({ state: "release", value: usd }))).toEqual({
      kind: "money",
      money: { micros: "0", currency: "USD" },
    });
    expect(
      costOf(
        mandateDraw({
          state: "release",
          value: { kind: "count", count: "3", unit: "calls" },
        }),
      ),
    ).toEqual({ kind: "count", count: "0", unit: "calls" });
    expect(costOf(mandateDraw({ state: "settle", value: usd }))).toEqual(usd);
    expect(costOf(mandateDraw({ state: "reserve", value: usd }))).toEqual(usd);
  });
});
