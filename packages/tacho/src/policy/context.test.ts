import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS } from "./builtins";
import { UNLIMITED_CENTS, callContext, clockContext, typedArgs } from "./context";

// Tuesday 2026-09-22 at 11:30 UTC, and Saturday 2026-09-26 at 18:05 UTC.
const TUESDAY = Date.parse("2026-09-22T11:30:00.000Z");
const SATURDAY = Date.parse("2026-09-26T18:05:00.000Z");

describe("clockContext", () => {
  it("reads the UTC hour and whether the day is a weekday", () => {
    expect(clockContext(TUESDAY)).toEqual({ hour_utc: 11, weekday: true });
    expect(clockContext(SATURDAY)).toEqual({ hour_utc: 18, weekday: false });
    expect(clockContext(Date.parse("2026-09-27T00:00:00.000Z")).weekday).toBe(false);
    expect(clockContext(Date.parse("2026-09-21T00:00:00.000Z")).weekday).toBe(true);
  });
});

describe("callContext", () => {
  const tool = { name: "builtin__shell", ...BUILTIN_TOOLS.builtin__shell };

  it("fills every part the caller does not know with its empty value", () => {
    expect(callContext({ tool, now: TUESDAY, tier: "harness" })).toEqual({
      tool: {
        name: "builtin__shell",
        version: 1,
        risk: "high",
        side_effect: "irreversible",
        egress: "third_party",
        impacts: [],
      },
      args: {},
      taint: { tainted: false, sources: [] },
      time: { hour_utc: 11, weekday: true },
      rate: { calls_last_hour: 0, calls_last_minute: 0 },
      run: { prior_calls: [], prior_reads: [] },
      operator: { role: "developer" },
      tier: "harness",
      budget: { remaining_cents: UNLIMITED_CENTS },
      approval: { granted: false, approvers: 0 },
    });
  });

  it("carries every part the caller knows", () => {
    const context = callContext({
      tool: { ...tool, impacts: ["customer_data"] },
      args: { command: "ls" },
      taint: { tainted: true, sources: ["web"] },
      now: SATURDAY,
      rate: { calls_last_hour: 4, calls_last_minute: 1 },
      run: { prior_calls: ["github__get_file_contents"], prior_reads: ["main"] },
      operator_role: "sre",
      tier: "gateway",
      budget_remaining_cents: 1200,
      mandate_remaining_cents: 500,
      approval: { granted: true, approvers: 2 },
      harness_tool: "Bash",
      skill: "release-notes",
    });
    expect(context).toMatchObject({
      args: { command: "ls" },
      taint: { tainted: true, sources: ["web"] },
      time: { hour_utc: 18, weekday: false },
      rate: { calls_last_hour: 4, calls_last_minute: 1 },
      operator: { role: "sre" },
      tier: "gateway",
      budget: { remaining_cents: 1200 },
      mandate: { remaining_cents: 500 },
      approval: { granted: true, approvers: 2 },
      harness_tool: "Bash",
      skill: "release-notes",
    });
    expect((context["tool"] as { impacts: string[] }).impacts).toEqual(["customer_data"]);
  });

  it("copies the impacts, so a later change to the tool does not reach the request", () => {
    const impacts = ["a"];
    const context = callContext({ tool: { ...tool, impacts }, now: TUESDAY, tier: "harness" });
    impacts.push("b");
    expect((context["tool"] as { impacts: string[] }).impacts).toEqual(["a"]);
  });
});

describe("typedArgs", () => {
  const types = {
    amount: "Long",
    customer_id: "String",
    dry_run: "Bool",
    labels: "Set<String>",
    ids: "Set<Long>",
  } as const;

  it("keeps each argument whose value matches its type", () => {
    expect(
      typedArgs(
        { amount: 4000, customer_id: "cus_1", dry_run: false, labels: ["a"], ids: [1, 2] },
        types,
      ),
    ).toEqual({
      args: { amount: 4000, customer_id: "cus_1", dry_run: false, labels: ["a"], ids: [1, 2] },
      errors: [],
    });
  });

  it("drops an argument the schema does not name, and a null one", () => {
    expect(typedArgs({ note: "hi", customer_id: null, amount: undefined }, types)).toEqual({
      args: {},
      errors: [],
    });
    expect(typedArgs(undefined, types)).toEqual({ args: {}, errors: [] });
  });

  it("reports an argument of the wrong type", () => {
    const { args, errors } = typedArgs(
      {
        amount: "64000",
        customer_id: 7,
        dry_run: "no",
        labels: ["a", 1],
        ids: [1.5],
      },
      types,
    );
    expect(args).toEqual({});
    expect(errors).toEqual([
      "Argument amount is not a Long.",
      "Argument customer_id is not a String.",
      "Argument dry_run is not a Bool.",
      "Argument labels is not a Set<String>.",
      "Argument ids is not a Set<Long>.",
    ]);
  });

  it("refuses a number too large for a Long", () => {
    expect(typedArgs({ amount: 2 ** 60 }, types).errors).toEqual([
      "Argument amount is not a Long.",
    ]);
  });

  it("does not read a type off the map's prototype", () => {
    expect(typedArgs({ toString: "x", constructor: 1 }, types)).toEqual({ args: {}, errors: [] });
  });
});
