/**
 * The evaluator's contract: deterministic verdicts, a total rule order, safe
 * fact resolution, and the refund scenario the engine exists for.
 */
import { describe, expect, test } from "vitest";
import {
  capabilityMatches,
  evaluateCondition,
  evaluateRules,
  requiredFactKeys,
} from "./evaluate";
import { parseRuleSet } from "./schema";
import type { DecisionSubject, RuleSet } from "./types";

/** The worked example: refund governance as a support team would write it. */
const REFUND_RULES: RuleSet = parseRuleSet({
  schema: "oxagen.decision-rules.v1",
  rules: [
    {
      id: "refund.deny-over-500",
      description: "Refunds over $500 are never issued by an agent.",
      capability: "issue_refund",
      priority: 100,
      when: { fact: "input.amount_usd", op: "gt", value: 500 },
      effect: "deny",
    },
    {
      id: "refund.approval-over-50",
      description: "Refunds over $50 need a person to approve.",
      capability: "issue_refund",
      priority: 90,
      when: { fact: "input.amount_usd", op: "gt", value: 50 },
      effect: "require_approval",
    },
    {
      id: "refund.rate-limit",
      description: "At most 3 refunds per customer per 30 days.",
      capability: "issue_refund",
      priority: 80,
      when: { fact: "facts.refunds_last_30d", op: "gte", value: 3 },
      effect: "deny",
      requires_facts: ["refunds_last_30d"],
    },
    {
      id: "refund.small-auto",
      description: "Small refunds are allowed without approval.",
      capability: "issue_refund",
      priority: 0,
      when: { fact: "input.amount_usd", op: "lte", value: 50 },
      effect: "allow",
    },
  ],
});

function refund(
  amount: number,
  facts: Record<string, unknown> = {},
): DecisionSubject {
  return {
    capability: "issue_refund",
    input: { amount_usd: amount },
    facts,
  };
}

describe("the refund scenario", () => {
  test("a small refund is allowed by the auto rule", () => {
    expect(evaluateRules(REFUND_RULES, refund(20))).toMatchObject({
      effect: "allow",
      ruleId: "refund.small-auto",
    });
  });

  test("a mid-size refund requires approval", () => {
    expect(evaluateRules(REFUND_RULES, refund(200))).toMatchObject({
      effect: "require_approval",
      ruleId: "refund.approval-over-50",
    });
  });

  test("a large refund is denied outright, not sent to approval", () => {
    expect(evaluateRules(REFUND_RULES, refund(5000))).toMatchObject({
      effect: "deny",
      ruleId: "refund.deny-over-500",
    });
  });

  test("the rate limit binds a small refund when the fact says so", () => {
    expect(
      evaluateRules(REFUND_RULES, refund(20, { refunds_last_30d: 3 })),
    ).toMatchObject({ effect: "deny", ruleId: "refund.rate-limit" });
  });

  test("an unresolved rate-limit fact degrades that rule to no-match", () => {
    // The fact source being down must not block small refunds — the amount
    // rules still bind, and the rate rule simply has nothing to read.
    expect(evaluateRules(REFUND_RULES, refund(20))).toMatchObject({
      effect: "allow",
    });
  });

  test("a different capability gets no opinion at all", () => {
    expect(
      evaluateRules(REFUND_RULES, {
        capability: "send_email",
        input: {},
        facts: {},
      }),
    ).toBeNull();
  });

  test("requiredFactKeys names exactly what the gate must resolve", () => {
    expect(requiredFactKeys(REFUND_RULES, "issue_refund")).toEqual([
      "refunds_last_30d",
    ]);
    expect(requiredFactKeys(REFUND_RULES, "send_email")).toEqual([]);
  });
});

describe("ordering is total", () => {
  test("priority wins, then id — regardless of authoring order", () => {
    const a: RuleSet = {
      schema: "oxagen.decision-rules.v1",
      rules: [
        { id: "b", description: "b", capability: "*", effect: "deny" },
        { id: "a", description: "a", capability: "*", effect: "allow" },
      ],
    };
    const b: RuleSet = {
      schema: "oxagen.decision-rules.v1",
      rules: [...a.rules].reverse(),
    };
    const subject: DecisionSubject = { capability: "x", input: {}, facts: {} };
    // Same priority ⇒ id "a" wins in both authorings.
    expect(evaluateRules(a, subject)).toMatchObject({ ruleId: "a" });
    expect(evaluateRules(b, subject)).toMatchObject({ ruleId: "a" });
  });

  test("seeded randomized authoring orders never change the verdict", () => {
    // A hand-rolled property: shuffle the rule list under a deterministic
    // LCG and assert the verdict is order-independent, which is the whole
    // point of the total (priority, id) order.
    const rules = Array.from({ length: 12 }, (_, i) => ({
      id: `r${String(i).padStart(2, "0")}`,
      description: `rule ${i}`,
      capability: "act",
      priority: i % 4,
      when: { fact: "input.n", op: "gte" as const, value: i },
      effect: (["allow", "deny", "require_approval"] as const)[i % 3]!,
    }));
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const shuffle = <T>(xs: T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    };
    for (let n = 0; n < 12; n++) {
      const subject: DecisionSubject = {
        capability: "act",
        input: { n },
        facts: {},
      };
      const reference = evaluateRules(
        { schema: "oxagen.decision-rules.v1", rules },
        subject,
      );
      for (let trial = 0; trial < 20; trial++) {
        const shuffled = evaluateRules(
          { schema: "oxagen.decision-rules.v1", rules: shuffle(rules) },
          subject,
        );
        expect(shuffled).toEqual(reference);
      }
    }
  });
});

describe("conditions", () => {
  const subject: DecisionSubject = {
    capability: "x",
    input: {
      tier: "pro",
      tags: ["vip", "beta"],
      amount: 10,
      nested: { deep: 1 },
    },
    facts: { region: "eu" },
    call: { surface: "api" },
  };

  test("all/any/not compose, with identity elements", () => {
    expect(evaluateCondition({ all: [] }, subject)).toBe(true);
    expect(evaluateCondition({ any: [] }, subject)).toBe(false);
    expect(
      evaluateCondition(
        {
          all: [
            { fact: "input.tier", op: "eq", value: "pro" },
            {
              any: [
                { fact: "facts.region", op: "in", value: ["us", "eu"] },
                { fact: "call.surface", op: "eq", value: "mcp" },
              ],
            },
            { not: { fact: "input.amount", op: "gt", value: 100 } },
          ],
        },
        subject,
      ),
    ).toBe(true);
  });

  test("dot paths reach nested input and unknown roots never match", () => {
    expect(
      evaluateCondition(
        { fact: "input.nested.deep", op: "eq", value: 1 },
        subject,
      ),
    ).toBe(true);
    expect(evaluateCondition({ fact: "env.HOME", op: "exists" }, subject)).toBe(
      false,
    );
  });

  test("numeric operators refuse string numbers — no coercion", () => {
    const s: DecisionSubject = {
      capability: "x",
      input: { amount: "50" },
      facts: {},
    };
    expect(
      evaluateCondition({ fact: "input.amount", op: "lte", value: 50 }, s),
    ).toBe(false);
  });

  test("contains works for strings and arrays; starts_with for strings", () => {
    expect(
      evaluateCondition(
        { fact: "input.tags", op: "contains", value: "vip" },
        subject,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { fact: "input.tier", op: "starts_with", value: "pr" },
        subject,
      ),
    ).toBe(true);
  });

  test("prototype-pollution-shaped paths do not resolve", () => {
    expect(
      evaluateCondition(
        { fact: "input.constructor.prototype", op: "exists" },
        subject,
      ),
    ).toBe(false);
  });
});

describe("capabilityMatches", () => {
  test("exact, prefix and universal forms", () => {
    expect(capabilityMatches("issue_refund", "issue_refund")).toBe(true);
    expect(capabilityMatches("refund_*", "refund_partial")).toBe(true);
    expect(capabilityMatches("refund_*", "issue_refund")).toBe(false);
    expect(capabilityMatches("*", "anything")).toBe(true);
  });
});
