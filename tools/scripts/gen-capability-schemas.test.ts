import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import { runSeal } from "@oxagen/oxagen/contracts/run.seal";
import { toJsonSchema, type ZodLike } from "./lib/zod-json-schema";

describe("published price card cardinality", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/capabilities/schemas/set_price_entry.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  it("publishes the same array bounds the live contract enforces", () => {
    const bounds = doc.input.properties.additionalRates;
    expect(bounds).toMatchObject({ type: "array", minItems: 1, maxItems: 10 });
    for (const size of [0, 1, 10, 11]) {
      const input = {
        provider: "anthropic",
        model: "claude-sonnet-5",
        tokenClass: "input_uncached",
        usdPerMillion: 3,
        additionalRates: Array.from({ length: size }, () => ({
          tokenClass: "output",
          usdPerMillion: 15,
        })),
      };
      expect(costPriceEntrySet.input.safeParse(input).success).toBe(
        size >= bounds.minItems && size <= bounds.maxItems,
      );
    }
  });
});

describe("a field that falls back with .catch()", () => {
  const doc = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/capabilities/schemas/fetch_commands.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  it("publishes the control envelope's day spend as optional, with its real shape (ADR-160)", () => {
    const control = doc.output.properties.control;
    expect(control.required).not.toContain("agent_day_spend");
    expect(control.properties.agent_day_spend).toMatchObject({
      type: "object",
      required: ["day", "this_host_usd_micros", "other_hosts_usd_micros"],
    });
  });
});

/**
 * A Zod v3 number `_def` with the given checks. The package has no direct zod
 * dependency, so these mirror what Zod v3 stores: `.positive()` is
 * `{ kind: "min", value: 0, inclusive: false }`, `.nonnegative()` is the same
 * with `inclusive: true`, and `.int()` is `{ kind: "int" }`.
 */
function zodNumber(
  checks: Array<{ kind: string; value?: number; inclusive?: boolean }>,
): ZodLike {
  return { _def: { typeName: "ZodNumber", checks } };
}

describe("numeric bounds", () => {
  it.each([
    [
      "positive()",
      { kind: "min", value: 0, inclusive: false },
      { exclusiveMinimum: 0 },
    ],
    [
      "gt(5)",
      { kind: "min", value: 5, inclusive: false },
      { exclusiveMinimum: 5 },
    ],
    [
      "negative()",
      { kind: "max", value: 0, inclusive: false },
      { exclusiveMaximum: 0 },
    ],
    [
      "lt(5)",
      { kind: "max", value: 5, inclusive: false },
      { exclusiveMaximum: 5 },
    ],
  ])("publishes %s as an exclusive bound", (_name, check, expected) => {
    const schema = toJsonSchema(zodNumber([check]));
    expect(schema).toMatchObject({ type: "number", ...expected });
    expect(schema).not.toHaveProperty("minimum");
    expect(schema).not.toHaveProperty("maximum");
  });

  it.each([
    [
      "nonnegative()",
      { kind: "min", value: 0, inclusive: true },
      { minimum: 0 },
    ],
    ["min(5)", { kind: "min", value: 5, inclusive: true }, { minimum: 5 }],
    [
      "nonpositive()",
      { kind: "max", value: 0, inclusive: true },
      { maximum: 0 },
    ],
    ["max(5)", { kind: "max", value: 5, inclusive: true }, { maximum: 5 }],
  ])("publishes %s as an inclusive bound", (_name, check, expected) => {
    const schema = toJsonSchema(zodNumber([check]));
    expect(schema).toMatchObject({ type: "number", ...expected });
    expect(schema).not.toHaveProperty("exclusiveMinimum");
    expect(schema).not.toHaveProperty("exclusiveMaximum");
  });

  it("keeps the tightest of several bounds of one kind", () => {
    // `.nonnegative().safe()` adds a lower bound of MIN_SAFE_INTEGER after 0.
    const schema = toJsonSchema(
      zodNumber([
        { kind: "int" },
        { kind: "min", value: 0, inclusive: true },
        { kind: "min", value: Number.MIN_SAFE_INTEGER, inclusive: true },
        { kind: "max", value: Number.MAX_SAFE_INTEGER, inclusive: true },
        { kind: "max", value: 10, inclusive: true },
      ]),
    );
    expect(schema).toMatchObject({ type: "integer", minimum: 0, maximum: 10 });
  });

  it("matches the live seal_run contract, which refuses zero sealed sessions", () => {
    const doc = JSON.parse(
      readFileSync(
        new URL(
          "../../docs/capabilities/schemas/seal_run.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const field = doc.output.properties.sessionsSealed;
    expect(field).toEqual({ type: "integer", exclusiveMinimum: 0 });
    expect(toJsonSchema(runSeal.output as unknown as ZodLike)).toMatchObject({
      properties: { sessionsSealed: field },
    });
    const shape = (
      runSeal.output as unknown as {
        shape: {
          sessionsSealed: { safeParse(v: unknown): { success: boolean } };
        };
      }
    ).shape;
    expect(shape.sessionsSealed.safeParse(0).success).toBe(false);
    expect(shape.sessionsSealed.safeParse(1).success).toBe(true);
  });
});
