// tools.toml's snake-case classification and today's camelCase
// ToolClassification, each written from the other.
import { describe, expect, it } from "vitest";
import {
  effectiveAnnotations,
  fromCodeClassification,
  toCodeClassification,
  type ToolsClassification,
} from "./classification";
import type { ToolsEntry } from "./tools";

const full: ToolsClassification = {
  risk: "high",
  side_effect: "irreversible",
  egress: "third_party",
  impacts: ["moves_money"],
  measures: {
    amount: { path: "$.amount", type: "money", currency_path: "$.currency" },
    recipients: { path: "$.recipients", type: "count", unit: "recipients" },
  },
  data_classes: ["payment_card"],
};

describe("toCodeClassification", () => {
  it("maps every key to its camelCase field, and impacts to consequenceTags", () => {
    expect(toCodeClassification(full)).toStrictEqual({
      risk: "high",
      classification: {
        sideEffect: "irreversible",
        egress: "third_party",
        consequenceTags: ["moves_money"],
        measures: {
          amount: { path: "$.amount", type: "money", currencyPath: "$.currency" },
          recipients: { path: "$.recipients", type: "count", unit: "recipients" },
        },
        dataClasses: ["payment_card"],
      },
    });
  });

  it("gives a minimal entry empty lists and an empty measure map", () => {
    const minimal: ToolsClassification = { risk: "low", side_effect: "read", egress: "org_tenant" };
    expect(toCodeClassification(minimal)).toStrictEqual({
      risk: "low",
      classification: {
        sideEffect: "read",
        egress: "org_tenant",
        consequenceTags: [],
        measures: {},
        dataClasses: [],
      },
    });
  });

  it("copies the lists, so the result shares no array with the entry", () => {
    const { classification } = toCodeClassification(full);
    expect(classification.consequenceTags).not.toBe(full.impacts);
    expect(classification.dataClasses).not.toBe(full.data_classes);
  });

  it("throws when a tag appears twice", () => {
    const repeated: ToolsClassification = { ...full, impacts: ["moves_money", "moves_money"] };
    expect(() => toCodeClassification(repeated)).toThrow("a tag appears once");
  });

  it("throws when a money measure names no currency", () => {
    const noCurrency: ToolsClassification = {
      ...full,
      measures: { amount: { path: "$.amount", type: "money" } },
    };
    expect(() => toCodeClassification(noCurrency)).toThrow("a money measure names the path to its currency");
  });
});

describe("fromCodeClassification", () => {
  it("writes back the entry toCodeClassification read", () => {
    const { risk, classification } = toCodeClassification(full);
    expect(fromCodeClassification(risk, classification)).toStrictEqual(full);
  });

  it("leaves out empty lists and an empty measure map", () => {
    expect(
      fromCodeClassification("medium", {
        sideEffect: "write",
        egress: "local",
        consequenceTags: [],
        measures: {},
        dataClasses: [],
      }),
    ).toStrictEqual({ risk: "medium", side_effect: "write", egress: "local" });
  });

  it("keeps a measure's unit and leaves out a currency it does not have", () => {
    const entry = fromCodeClassification("low", {
      sideEffect: "read",
      egress: "org_tenant",
      consequenceTags: [],
      measures: { rows: { path: "$.limit", type: "count", unit: "rows" } },
      dataClasses: [],
    });
    expect(entry.measures).toStrictEqual({ rows: { path: "$.limit", type: "count", unit: "rows" } });
  });
});

describe("effectiveAnnotations", () => {
  const rows: Array<[ToolsEntry["side_effect"], ToolsEntry["egress"], boolean, boolean, boolean]> = [
    ["read", "org_tenant", true, false, false],
    ["read", "third_party", true, false, true],
    ["write", "local", false, false, false],
    ["write", "third_party", false, false, true],
    ["irreversible", "org_tenant", false, true, false],
    ["irreversible", "third_party", false, true, true],
  ];

  it.each(rows)(
    "side_effect %s and egress %s give readOnly %s, destructive %s, openWorld %s",
    (side_effect, egress, readOnlyHint, destructiveHint, openWorldHint) => {
      expect(effectiveAnnotations({ side_effect, egress })).toStrictEqual({
        readOnlyHint,
        destructiveHint,
        openWorldHint,
      });
    },
  );
});
