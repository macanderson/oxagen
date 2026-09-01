/** Authoring validation: what a publish must refuse. */
import { describe, expect, test } from "vitest";
import { parseRuleSet } from "./schema";

const base = {
  schema: "oxagen.decision-rules.v1",
  rules: [
    {
      id: "r1",
      description: "d",
      capability: "issue_refund",
      effect: "deny",
    },
  ],
};

describe("parseRuleSet", () => {
  test("accepts a minimal valid set", () => {
    expect(parseRuleSet(base).rules).toHaveLength(1);
  });

  test("rejects duplicate rule ids — they are the audit citation", () => {
    expect(() =>
      parseRuleSet({ ...base, rules: [base.rules[0], base.rules[0]] }),
    ).toThrow(/duplicate rule id/);
  });

  test("rejects a value-less comparison but allows bare exists", () => {
    expect(() =>
      parseRuleSet({
        ...base,
        rules: [{ ...base.rules[0], when: { fact: "input.x", op: "gt" } }],
      }),
    ).toThrow(/needs a value/);
    expect(
      parseRuleSet({
        ...base,
        rules: [{ ...base.rules[0], when: { fact: "input.x", op: "exists" } }],
      }).rules,
    ).toHaveLength(1);
  });

  test("rejects fact paths outside the three roots", () => {
    expect(() =>
      parseRuleSet({
        ...base,
        rules: [{ ...base.rules[0], when: { fact: "env.HOME", op: "exists" } }],
      }),
    ).toThrow(/fact paths start/);
  });

  test("rejects an unknown schema literal and unknown keys", () => {
    expect(() => parseRuleSet({ ...base, schema: "v2" })).toThrow();
    expect(() =>
      parseRuleSet({
        ...base,
        rules: [{ ...base.rules[0], sneaky: true }],
      }),
    ).toThrow();
  });

  test("rejects a capability pattern with an interior wildcard", () => {
    expect(() =>
      parseRuleSet({
        ...base,
        rules: [{ ...base.rules[0], capability: "re*fund" }],
      }),
    ).toThrow();
  });
});
