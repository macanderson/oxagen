import { describe, expect, it } from "vitest";
import {
  createDaySpend,
  nextUtcDayStart,
  type RecordedDaySpend,
  utcDay,
} from "./day-spend";

describe("utcDay", () => {
  it("names the UTC calendar day, whatever the host's timezone", () => {
    expect(utcDay(Date.parse("2026-09-24T23:59:59.999Z"))).toBe("2026-09-24");
    expect(utcDay(Date.parse("2026-09-25T00:00:00.000Z"))).toBe("2026-09-25");
    // 17:30 in UTC-07:00 is already the next UTC day.
    expect(utcDay(Date.parse("2026-09-24T17:30:00-07:00"))).toBe("2026-09-25");
  });

  it("names the instant the next UTC day starts, across a month end", () => {
    expect(nextUtcDayStart("2026-09-30")).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("createDaySpend", () => {
  it("seeds a day once from the WAL and adds each priced call to it", () => {
    const seeded: string[] = [];
    const spend = createDaySpend({
      priorDaySpendMicros: (day) => {
        seeded.push(day);
        return 4_000;
      },
    });
    expect(spend.total("2026-09-24")).toBe(4_000);
    spend.add("2026-09-24", 1_500);
    expect(spend.total("2026-09-24")).toBe(5_500);
    expect(seeded).toEqual(["2026-09-24"]);
  });

  it("starts the next UTC day from that day's seed, not from yesterday's total", () => {
    const spend = createDaySpend({
      priorDaySpendMicros: (day) => (day === "2026-09-24" ? 9_000 : 250),
    });
    spend.add("2026-09-24", 1_000);
    expect(spend.total("2026-09-24")).toBe(10_000);
    expect(spend.total("2026-09-25")).toBe(250);
    spend.add("2026-09-25", 50);
    expect(spend.total("2026-09-25")).toBe(300);
  });

  it("never reopens a day it has left when the clock steps back (negative)", () => {
    const spend = createDaySpend({ priorDaySpendMicros: () => 100 });
    spend.add("2026-09-25", 10);
    spend.add("2026-09-24", 5);
    expect(spend.total("2026-09-24")).toBe(115);
    expect(spend.total("2026-09-25")).toBe(115);
  });

  it("adds the other hosts and takes the larger of this host's two counts", () => {
    let recorded: RecordedDaySpend | undefined = {
      day: "2026-09-24",
      thisHostMicros: 2_000,
      otherHostsMicros: 7_000,
    };
    const spend = createDaySpend({
      priorDaySpendMicros: () => 3_000,
      recordedDaySpend: () => recorded,
    });
    // The WAL counts more than has shipped: this host's WAL wins.
    expect(spend.total("2026-09-24")).toBe(10_000);
    // A wiped WAL: what the control plane holds for this host wins.
    recorded = {
      day: "2026-09-24",
      thisHostMicros: 8_000,
      otherHostsMicros: 7_000,
    };
    expect(spend.total("2026-09-24")).toBe(15_000);
  });

  it("ignores a control-plane figure for another day (negative)", () => {
    const spend = createDaySpend({
      priorDaySpendMicros: () => 1_000,
      recordedDaySpend: () => ({
        day: "2026-09-23",
        thisHostMicros: 50_000,
        otherHostsMicros: 50_000,
      }),
    });
    expect(spend.total("2026-09-24")).toBe(1_000);
  });

  it("counts zero for a read that throws or answers nonsense, rather than stopping a call (negative)", () => {
    const spend = createDaySpend({
      priorDaySpendMicros: () => {
        throw new Error("WAL unreadable");
      },
      recordedDaySpend: () => {
        throw new Error("no envelope");
      },
    });
    expect(spend.total("2026-09-24")).toBe(0);
    const odd = createDaySpend({
      priorDaySpendMicros: () => Number.NaN,
      recordedDaySpend: () => ({
        day: "2026-09-24",
        thisHostMicros: -5,
        otherHostsMicros: Number.POSITIVE_INFINITY,
      }),
    });
    expect(odd.total("2026-09-24")).toBe(0);
    odd.add("2026-09-24", -40);
    expect(odd.total("2026-09-24")).toBe(0);
  });
});
