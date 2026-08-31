/**
 * The gate's failure-direction contract: open on its own infrastructure,
 * closed on a computed verdict.
 */
import { describe, expect, test, vi } from "vitest";
import {
  createDecisionRulesGate,
  DecisionRuleApprovalRequiredError,
  DecisionRuleDeniedError,
} from "./gate";
import type { RuleSet } from "./types";

const RULES: RuleSet = {
  schema: "oxagen.decision-rules.v1",
  rules: [
    {
      id: "deny-big",
      description: "big refunds are refused",
      capability: "issue_refund",
      priority: 10,
      when: { fact: "input.amount_usd", op: "gt", value: 500 },
      effect: "deny",
    },
    {
      id: "approve-medium",
      description: "medium refunds need a person",
      capability: "issue_refund",
      when: { fact: "input.amount_usd", op: "gt", value: 50 },
      effect: "require_approval",
    },
    {
      id: "rate",
      description: "too many recent refunds",
      capability: "issue_refund",
      priority: 20,
      when: { fact: "facts.refunds_last_30d", op: "gte", value: 3 },
      effect: "deny",
      requires_facts: ["refunds_last_30d"],
    },
  ],
};

const CTX = { orgId: "org1", workspaceId: "ws1", userId: null };

describe("createDecisionRulesGate", () => {
  test("enforces a deny as a typed error citing the rule", async () => {
    const gate = createDecisionRulesGate({ loadRuleSet: async () => RULES });
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 900 },
        ctx: CTX,
      }),
    ).rejects.toThrow(DecisionRuleDeniedError);
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 900 },
        ctx: CTX,
      }),
    ).rejects.toThrow(/deny-big/);
  });

  test("surfaces require_approval as its own error type", async () => {
    const gate = createDecisionRulesGate({ loadRuleSet: async () => RULES });
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 100 },
        ctx: CTX,
      }),
    ).rejects.toThrow(DecisionRuleApprovalRequiredError);
  });

  test("no rule set, empty rule set, or unmatched capability all proceed", async () => {
    for (const loadRuleSet of [
      async () => null,
      async () =>
        ({ schema: "oxagen.decision-rules.v1", rules: [] }) as RuleSet,
      async () => RULES,
    ]) {
      const gate = createDecisionRulesGate({ loadRuleSet });
      await expect(
        gate({ capability: "send_email", input: {}, ctx: CTX }),
      ).resolves.toBeUndefined();
    }
  });

  test("resolves only the facts the candidate rules declare, and uses them", async () => {
    const resolveFacts = vi.fn(async () => ({ refunds_last_30d: 5 }));
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      resolveFacts,
    });
    await expect(
      gate({ capability: "issue_refund", input: { amount_usd: 10 }, ctx: CTX }),
    ).rejects.toThrow(/rate/);
    expect(resolveFacts).toHaveBeenCalledWith(
      expect.objectContaining({ keys: ["refunds_last_30d"] }),
    );
  });

  test("fails OPEN when the loader throws — and reports it", async () => {
    // A broken rules store must not take every agent action down with it;
    // the same posture as the workspace budget-governance read.
    const onError = vi.fn();
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => {
        throw new Error("rules store down");
      },
      onError,
    });
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 9999 },
        ctx: CTX,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("a dead fact source does NOT fail open the input-shaped rules", async () => {
    const onError = vi.fn();
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      resolveFacts: async () => {
        throw new Error("clickhouse down");
      },
      onError,
    });
    // The rate rule degrades to no-match, but the amount rule still binds.
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 900 },
        ctx: CTX,
      }),
    ).rejects.toThrow(DecisionRuleDeniedError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("an allow verdict stops evaluation and proceeds", async () => {
    const withAllow: RuleSet = {
      schema: "oxagen.decision-rules.v1",
      rules: [
        {
          id: "allow-support",
          description: "support surface refunds are pre-cleared",
          capability: "issue_refund",
          priority: 100,
          when: { fact: "call.surface", op: "eq", value: "support" },
          effect: "allow",
        },
        ...RULES.rules,
      ],
    };
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => withAllow,
    });
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 900 },
        ctx: { ...CTX, surface: "support" },
      }),
    ).resolves.toBeUndefined();
  });
});
