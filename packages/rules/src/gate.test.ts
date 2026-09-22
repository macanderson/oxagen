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
  test.each(["missing", "offline", "incomplete"])(
    "refuses fresh admission when rule facts are %s",
    async (failure) => {
      const resolveFacts =
        failure === "missing"
          ? undefined
          : async () => {
              if (failure === "offline") throw new Error("facts offline");
              return {};
            };
      const gate = createDecisionRulesGate({
        loadRuleSet: async () => RULES,
        resolveFacts,
      });
      await expect(
        gate({
          capability: "issue_refund",
          input: { amount_usd: 10 },
          ctx: CTX,
          requireFreshRules: true,
        }),
      ).rejects.toMatchObject({ code: "decision_rules_unavailable" });
    },
  );

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

// ── The mandate check (ADR-059 decision 4) ───────────────────────────────────
//
// The gate runs it after the rules, for an agent principal with a workspace,
// and hands the kernel whatever settlement it returns. Every other principal
// shape skips it; a rules deny still wins before it runs.

describe("createDecisionRulesGate — the mandate check", () => {
  const settlement = {
    settle: async () => undefined,
    release: async () => undefined,
  };
  const agent = {
    id: "prn_agent",
    kind: "agent" as const,
    orgId: "org1",
    workspaceId: "ws1",
  };
  const human = { ...agent, id: "prn_human", kind: "human" as const };

  test("runs for an agent principal with the capability, input, tenant and principal id, and returns its settlement", async () => {
    const checkMandate = vi.fn(async () => settlement);
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => null,
      checkMandate,
    });
    await expect(
      gate({
        capability: "stripe__create_payment",
        input: { amount: "12.50" },
        ctx: { ...CTX, userId: "u1", requestId: "req_1" },
        principal: agent,
      }),
    ).resolves.toBe(settlement);
    expect(checkMandate).toHaveBeenCalledWith({
      capability: "stripe__create_payment",
      input: { amount: "12.50" },
      orgId: "org1",
      workspaceId: "ws1",
      agentPrincipalId: "prn_agent",
      userId: "u1",
      requestId: "req_1",
    });
  });

  test.each([
    ["a human principal", { principal: human }],
    [
      "a service principal",
      { principal: { ...agent, kind: "service" as const } },
    ],
    ["no principal", { principal: null }],
    ["an absent principal", {}],
    [
      "an agent with no workspace",
      { principal: agent, ctx: { ...CTX, workspaceId: null } },
    ],
  ])("skips the check for %s", async (_label, extra) => {
    const checkMandate = vi.fn(async () => settlement);
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => null,
      checkMandate,
    });
    await expect(
      gate({
        capability: "stripe__create_payment",
        input: {},
        ctx: CTX,
        ...extra,
      }),
    ).resolves.toBeUndefined();
    expect(checkMandate).not.toHaveBeenCalled();
  });

  test("a rules deny wins before the mandate check runs", async () => {
    const checkMandate = vi.fn(async () => settlement);
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      checkMandate,
    });
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 900 },
        ctx: CTX,
        principal: agent,
      }),
    ).rejects.toThrow(DecisionRuleDeniedError);
    expect(checkMandate).not.toHaveBeenCalled();
  });

  test("a mandate refusal is enforced, never failed open", async () => {
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => null,
      checkMandate: async () => {
        throw new Error("no_mandate");
      },
      onError: vi.fn(),
    });
    await expect(
      gate({ capability: "x", input: {}, ctx: CTX, principal: agent }),
    ).rejects.toThrow("no_mandate");
  });

  test("without a configured check every agent call proceeds on the rules alone", async () => {
    const gate = createDecisionRulesGate({ loadRuleSet: async () => null });
    await expect(
      gate({ capability: "x", input: {}, ctx: CTX, principal: agent }),
    ).resolves.toBeUndefined();
  });
});

/**
 * The auto-approval clause of the same rule set (ADR-070): what the gate does
 * with a `require_approval` verdict it is told may skip the person.
 */
describe("auto-approval at a require_approval verdict", () => {
  const parked = {
    capability: "issue_refund",
    input: { amount_usd: 100 },
    ctx: CTX,
  };

  test("releases the call when a rule qualified, and asks only at that verdict", async () => {
    const commit = vi.fn(async () => {});
    const autoApprove = vi.fn(async () => ({ ok: true, commit }));
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove,
    });
    await expect(gate(parked)).resolves.toBeUndefined();
    expect(commit).toHaveBeenCalledOnce();
    expect(autoApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "issue_refund",
        verdict: expect.objectContaining({ ruleId: "approve-medium" }),
        ctx: { orgId: "org1", workspaceId: "ws1", userId: null, runId: null },
      }),
    );

    // A deny and a call no rule matches never reach it.
    autoApprove.mockClear();
    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 900 },
        ctx: CTX,
      }),
    ).rejects.toThrow(DecisionRuleDeniedError);
    await expect(
      gate({ capability: "send_email", input: {}, ctx: CTX }),
    ).resolves.toBeUndefined();
    expect(autoApprove).not.toHaveBeenCalled();
  });

  // #3153: an auto-approved receipt must name the run it belongs to, so
  // list_resolved_approvals can find it. The gate is the thread from the
  // kernel's agent-run context to the write path.
  test("threads the call's run id through to the auto-approval hook", async () => {
    const commit = vi.fn(async () => {});
    const autoApprove = vi.fn(async () => ({ ok: true, commit }));
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove,
    });
    await gate({ ...parked, ctx: { ...CTX, runId: "run-uuid-1" } });
    expect(autoApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ runId: "run-uuid-1" }),
      }),
    );
  });

  test("leaves the call with the person when no rule qualified, or none covered it", async () => {
    for (const outcome of [{ ok: false }, null]) {
      const gate = createDecisionRulesGate({
        loadRuleSet: async () => RULES,
        autoApprove: async () => outcome,
      });
      await expect(gate(parked)).rejects.toThrow(
        DecisionRuleApprovalRequiredError,
      );
    }
  });

  test("a hook that throws leaves the call with the person, and reports it", async () => {
    const onError = vi.fn();
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => {
        throw new Error("approval store down");
      },
      onError,
    });
    await expect(gate(parked)).rejects.toThrow(
      DecisionRuleApprovalRequiredError,
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  test("a call with no workspace never auto-approves — the rules are a workspace's", async () => {
    const autoApprove = vi.fn(async () => ({
      ok: true,
      commit: async () => {},
    }));
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove,
    });
    await expect(
      gate({ ...parked, ctx: { ...CTX, workspaceId: null } }),
    ).rejects.toThrow(DecisionRuleApprovalRequiredError);
    expect(autoApprove).not.toHaveBeenCalled();
  });
});

/**
 * The receipt saying no person looked is written last, because a mandate's
 * own approval rule runs after the rules and can still park the call
 * (ADR-070). A `policy:<rule id>` row for a call a person was required to
 * look at would invert the one thing that form exists for.
 */
describe("the auto-approval receipt is written after every later check", () => {
  const agent = {
    kind: "agent" as const,
    id: "prn_agent",
  } as unknown as Parameters<
    ReturnType<typeof createDecisionRulesGate>
  >[0]["principal"];
  const parkedByAgent = {
    capability: "issue_refund",
    input: { amount_usd: 100 },
    ctx: CTX,
    principal: agent,
  };

  test("a mandate that parks the call leaves no receipt behind", async () => {
    const commit = vi.fn(async () => {});
    const checkMandate = vi.fn(async () => {
      throw new Error("the mandate requires a person");
    });
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({ ok: true, commit }),
      checkMandate,
    });
    await expect(gate(parkedByAgent)).rejects.toThrow(
      "the mandate requires a person",
    );
    expect(checkMandate).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  test("a mandate that clears lets the receipt be written, once, and returns its settlement", async () => {
    const commit = vi.fn(async () => {});
    const settlement = { settle: async () => {}, release: async () => {} };
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({ ok: true, commit }),
      checkMandate: async () => settlement,
    });
    await expect(gate(parkedByAgent)).resolves.toBe(settlement);
    expect(commit).toHaveBeenCalledOnce();
  });

  test("a hook that says ok and hands back nothing to write sends the call to a person", async () => {
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({ ok: true }),
    });
    await expect(gate(parkedByAgent)).rejects.toThrow(
      DecisionRuleApprovalRequiredError,
    );
  });

  test("a receipt that cannot be written sends the call to a person, and reports it", async () => {
    const onError = vi.fn();
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({
        ok: true,
        commit: async () => {
          throw new Error("approval insert failed");
        },
      }),
      onError,
    });
    await expect(gate(parkedByAgent)).rejects.toThrow(
      /auto_approval_not_recorded/,
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  test("a receipt that cannot be written gives the mandate's reservation back", async () => {
    // The mandate reserved before the receipt was attempted, and a throw from
    // here never returns the settlement to the kernel — so nothing else would
    // ever release it, and the mandate's remaining authority would shrink on
    // every failed call.
    const release = vi.fn(async () => {});
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({
        ok: true,
        commit: async () => {
          throw new Error("approval insert failed");
        },
      }),
      checkMandate: async () => ({ settle: async () => {}, release }),
      onError: vi.fn(),
    });
    await expect(gate(parkedByAgent)).rejects.toThrow(
      /auto_approval_not_recorded/,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  test("a release that itself fails is reported and does not replace the refusal", async () => {
    const onError = vi.fn();
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({
        ok: true,
        commit: async () => {
          throw new Error("approval insert failed");
        },
      }),
      checkMandate: async () => ({
        settle: async () => {},
        release: async () => {
          throw new Error("ledger unreachable");
        },
      }),
      onError,
    });
    // The caller still learns why the call was refused, not why the cleanup was.
    await expect(gate(parkedByAgent)).rejects.toThrow(
      /auto_approval_not_recorded/,
    );
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test("a receipt that is written keeps the reservation, for the handler to settle", async () => {
    const release = vi.fn(async () => {});
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => RULES,
      autoApprove: async () => ({ ok: true, commit: async () => {} }),
      checkMandate: async () => ({ settle: async () => {}, release }),
    });
    await expect(gate(parkedByAgent)).resolves.toBeDefined();
    expect(release).not.toHaveBeenCalled();
  });
});

/**
 * An external transport reaches the gate under the name its server returned.
 * The registry holds the same tool under the lower-cased slug an operator
 * reads a rule pattern back from, so the gate governs the call whichever of
 * the two spellings the rule was written in (ADR-138, #3137).
 */
describe("external tool identity at the gate", () => {
  const SERVER = "3f6a1c20-0d8e-4a11-9a77-2b5c0e8a4d31";
  const EXTERNAL_RULES: RuleSet = {
    schema: "oxagen.decision-rules.v1",
    rules: [
      {
        id: "external.deny-charges",
        description: "No agent charges a card through this server",
        capability: `mcp.${SERVER}.chargecard`,
        effect: "deny",
      },
    ],
  };

  test("refuses the transport whichever case the server spells the tool in", async () => {
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => EXTERNAL_RULES,
    });
    for (const capability of [
      `mcp.${SERVER}.chargeCard`,
      `mcp.${SERVER}.chargecard`,
      `mcp.${SERVER}.CHARGECARD`,
    ]) {
      await expect(
        gate({ capability, input: { amount: 10_000 }, ctx: CTX, external: {} }),
      ).rejects.toMatchObject({
        code: "decision_rule_denied",
        verdict: { ruleId: "external.deny-charges" },
      });
    }
  });

  test("leaves a different tool on the same server alone", async () => {
    const gate = createDecisionRulesGate({
      loadRuleSet: async () => EXTERNAL_RULES,
    });
    await expect(
      gate({
        capability: `mcp.${SERVER}.listCards`,
        input: {},
        ctx: CTX,
        external: {},
      }),
    ).resolves.toBeUndefined();
  });
});
