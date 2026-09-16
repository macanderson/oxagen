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

/**
 * The auto-approval clause (ADR-068). A v1 document has none; a v2 document
 * carries one, and what it may carry is what the evaluator can judge.
 */
const ruleBody = {
  id: "small-vendor-payments",
  name: "Small vendor payments",
  tools: ["stripe__create_payment@*"],
  createdBy: "usr_0123456789abcdefghjkmn",
  createdAt: "2026-09-02T00:00:00.000Z",
};
const v2 = {
  ...base,
  schema: "oxagen.decision-rules.v2",
  autoApproval: [ruleBody],
};

describe("the auto-approval clause", () => {
  test("a v1 document reads as a rule set with no clause", () => {
    expect(parseRuleSet(base).autoApproval).toEqual([]);
    expect(parseRuleSet(base).schema).toBe("oxagen.decision-rules.v1");
  });

  test("a v2 document carries the clause, with every condition defaulted off", () => {
    const parsed = parseRuleSet(v2);
    expect(parsed.schema).toBe("oxagen.decision-rules.v2");
    expect(parsed.autoApproval).toEqual([
      {
        ...ruleBody,
        enabled: true,
        maxMeasures: {},
        allowTargets: {},
        standingWindowMs: null,
        businessHours: null,
      },
    ]);
  });

  test("rejects duplicate rule ids in the clause", () => {
    expect(() =>
      parseRuleSet({ ...v2, autoApproval: [ruleBody, ruleBody] }),
    ).toThrow(/duplicate rule id/);
  });

  test("rejects a rule that names no tool", () => {
    expect(() =>
      parseRuleSet({ ...v2, autoApproval: [{ ...ruleBody, tools: [] }] }),
    ).toThrow();
  });

  test("rejects a measure ceiling that is not an integer string", () => {
    expect(() =>
      parseRuleSet({
        ...v2,
        autoApproval: [{ ...ruleBody, maxMeasures: { amount: "12.50" } }],
      }),
    ).toThrow();
  });

  test("rejects business hours in a zone this host cannot read", () => {
    const hours = {
      timezone: "Mars/Olympus",
      days: [1],
      start: "09:00",
      end: "17:00",
    };
    expect(() =>
      parseRuleSet({
        ...v2,
        autoApproval: [{ ...ruleBody, businessHours: hours }],
      }),
    ).toThrow(/IANA time-zone name/);
  });

  test("rejects business hours that end before they start, and a malformed time", () => {
    const base_hours = { timezone: "UTC", days: [1], start: "09:00" };
    expect(() =>
      parseRuleSet({
        ...v2,
        autoApproval: [
          { ...ruleBody, businessHours: { ...base_hours, end: "08:00" } },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseRuleSet({
        ...v2,
        autoApproval: [
          { ...ruleBody, businessHours: { ...base_hours, end: "24:00" } },
        ],
      }),
    ).toThrow();
  });

  test("rejects a standing window shorter than a minute or longer than 30 days", () => {
    const withWindow = (ms: number) => () =>
      parseRuleSet({
        ...v2,
        autoApproval: [{ ...ruleBody, standingWindowMs: ms }],
      });
    expect(withWindow(59_999)).toThrow();
    expect(withWindow(30 * 24 * 60 * 60 * 1000 + 1)).toThrow();
    expect(withWindow(60_000)).not.toThrow();
  });

  test("rejects an unknown key on a rule", () => {
    expect(() =>
      parseRuleSet({ ...v2, autoApproval: [{ ...ruleBody, minTrust: 800 }] }),
    ).toThrow();
  });
});
