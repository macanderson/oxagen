// The facts a run did not record that have no slot in the Run page head:
// what the head counts and what the Details drawer lists, each with the key
// of its reason.
import { describe, expect, it } from "vitest";
import { missingFacts } from "./missing-facts";
import { runRow } from "./run.builders";

/** A run whose record holds every fact the list can name. */
const whole = () =>
  runRow({ effort: "high", effortSource: "harness", completenessGaps: [] });

const enrolled = { checkout: true, machine: true };

describe("missingFacts", () => {
  it("lists nothing for a run that recorded every fact", () => {
    expect(missingFacts(whole(), { version: "2.1.0" }, enrolled)).toEqual([]);
  });

  it("names a harness nobody named, and not its version as well", () => {
    expect(
      missingFacts(whole(), null, enrolled).map((fact) => fact.id),
    ).toEqual(["harness"]);
  });

  it("names a harness version the harness did not report", () => {
    expect(missingFacts(whole(), { version: null }, enrolled)).toEqual([
      {
        id: "harnessVersion",
        label: "details.fact.harnessVersion",
        reason: "details.why.harnessVersion",
      },
    ]);
  });

  it("gives an effort not captured the reason the header gives it", () => {
    const gateway = runRow({ effort: null, enforcementTier: "gateway" });
    const observe = runRow({ effort: null, enforcementTier: "observe" });
    expect(
      missingFacts(gateway, { version: "2.1.0" }, enrolled).find(
        (fact) => fact.id === "effort",
      )?.reason,
    ).toBe("header.effortWhy.not_sent");
    expect(
      missingFacts(observe, { version: "2.1.0" }, enrolled).find(
        (fact) => fact.id === "effort",
      )?.reason,
    ).toBe("header.effortWhy.not_proxied");
  });

  it("lists each gap the seal recorded with its own words", () => {
    const run = runRow({
      effort: "high",
      completenessGaps: ["digest_only", "chain_break"],
    });
    expect(missingFacts(run, { version: "2.1.0" }, enrolled)).toEqual([
      {
        id: "gap.digest_only",
        label: "details.fact.gap",
        reason: "gap.digest_only",
      },
      {
        id: "gap.chain_break",
        label: "details.fact.gap",
        reason: "gap.chain_break",
      },
    ]);
  });

  it("counts a missing machine once and its path not at all", () => {
    const run = runRow({ effort: "high", machine: null });
    expect(
      missingFacts(run, { version: "2.1.0" }, {
        checkout: false,
        machine: false,
      }),
    ).toEqual([
      {
        id: "machine",
        label: "details.fact.machine",
        reason: "details.why.machine",
      },
    ]);
  });

  it("says a ledger run records no host", () => {
    const run = runRow({ effort: "high", machine: null, source: "ledger" });
    expect(
      missingFacts(run, { version: "2.1.0" }, null)[0]?.reason,
    ).toBe("header.noMachineOnLedger");
  });

  it("takes the machine the work read named when the row holds none (negative)", () => {
    const run = runRow({ effort: "high", machine: null });
    expect(missingFacts(run, { version: "2.1.0" }, enrolled)).toEqual([]);
  });

  it("names a path neither the session nor an enrolled checkout holds", () => {
    const run = runRow({ effort: "high", place: null });
    expect(
      missingFacts(run, { version: "2.1.0" }, {
        checkout: false,
        machine: true,
      }).map((fact) => fact.id),
    ).toEqual(["path"]);
  });

  it("claims no missing path while the work read has not answered (negative)", () => {
    const run = runRow({ effort: "high", place: null });
    expect(missingFacts(run, { version: "2.1.0" }, null)).toEqual([]);
  });

  it("takes the session's own directory as the path (negative)", () => {
    const run = runRow({
      effort: "high",
      place: { path: "/Users/mb/src/platform", branch: "fix/tags" },
    });
    expect(
      missingFacts(run, { version: "2.1.0" }, {
        checkout: false,
        machine: true,
      }),
    ).toEqual([]);
  });
});
