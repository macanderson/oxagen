import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";

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
