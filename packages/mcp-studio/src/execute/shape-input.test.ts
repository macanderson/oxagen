// shape-input.ts: the agent's arguments back into the upstream's names and values.
import { describe, expect, it } from "vitest";
import { shapeArguments } from "./shape-input";

const none = { hide: [], fixed: {}, defaults: {}, rename: {} };

describe("shapeArguments", () => {
  it("passes arguments through on a copy, and drops undefined values", () => {
    const args = { customer: "cus_81", limit: 2, cursor: undefined };
    const out = shapeArguments(args, none);
    expect(out).toEqual({ customer: "cus_81", limit: 2 });
    expect(Object.hasOwn(out, "cursor")).toBe(false);
    expect(out).not.toBe(args);
  });

  it("maps a renamed input back to its upstream name", () => {
    const shaping = { ...none, rename: { customer: "customer_id" } };
    expect(shapeArguments({ customer_id: "cus_81" }, shaping)).toEqual({ customer: "cus_81" });
  });

  it("drops an argument sent under the upstream name of a renamed input", () => {
    const shaping = { ...none, rename: { customer: "customer_id" } };
    expect(shapeArguments({ customer: "cus_x", limit: 1 }, shaping)).toEqual({ limit: 1 });
  });

  it("drops hidden inputs", () => {
    expect(shapeArguments({ internal: true, amount: 4000 }, { ...none, hide: ["internal"] })).toEqual({ amount: 4000 });
  });

  it("fills a default only where the agent left the input out", () => {
    const shaping = { ...none, defaults: { limit: 10 } };
    expect(shapeArguments({}, shaping)).toEqual({ limit: 10 });
    expect(shapeArguments({ limit: 5 }, shaping)).toEqual({ limit: 5 });
    expect(shapeArguments({ limit: undefined }, shaping)).toEqual({ limit: 10 });
  });

  it("sets a fixed value over what the agent sent", () => {
    expect(shapeArguments({ mode: "test" }, { ...none, fixed: { mode: "live" } })).toEqual({ mode: "live" });
  });

  it("gives a default to a hidden input, because hiding runs first", () => {
    const shaping = { ...none, hide: ["region"], defaults: { region: "us" } };
    expect(shapeArguments({ region: "eu" }, shaping)).toEqual({ region: "us" });
  });

  it("copies defaults and fixed values, so a later change to the result leaves the manifest alone", () => {
    const shaping = { ...none, defaults: { filter: { status: ["paid"] } }, fixed: { meta: { source: "oxagen" } } };
    const out = shapeArguments({}, shaping) as { filter: { status: string[] }; meta: { source: string } };
    out.filter.status.push("refunded");
    out.meta.source = "changed";
    expect(shaping.defaults.filter.status).toEqual(["paid"]);
    expect(shaping.fixed.meta.source).toBe("oxagen");
  });

  it("keeps a __proto__ argument as data", () => {
    const args: unknown = JSON.parse('{"__proto__": {"polluted": true}}');
    const out = shapeArguments(args as Record<string, unknown>, none);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
