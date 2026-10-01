import { beforeAll, describe, expect, it } from "vitest";
import type { CedarToolEntry } from "@oxagen/recorder";
import {
  CALL_RESOURCE,
  callContext,
  principalEntities,
  readCedarDecision,
  requireCedarRuntime,
  typedArgs,
  type CedarRuntime,
} from "@oxagen/recorder/policy";
import {
  convertDecisionRules,
  type ConditionLike,
  type ConditionOpLike,
  type ConvertedRules,
  type DecisionRuleLike,
} from "./decision-rules";
import { writeCedarSchema } from "./schema";

// Every expected verdict below is worked by hand from `evaluateRules` in
// `@oxagen/rules`: the first rule that matches decides, and a call no rule
// matches goes through.

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

type Tools = Record<string, CedarToolEntry>;

const AGENT = {
  name: "a-intel.core.release-bot",
  operator: "priya",
  runtime: "ci-linux-01",
  harness: "claude-code",
  workspace: "core-platform",
};

const NOW = Date.UTC(2026, 8, 24, 14, 0, 0);

/** The grant the steering repo's compiler writes, so a call no rule forbids goes through. */
const GRANT = "permit (principal, action, resource);";

const REFUND: CedarToolEntry = {
  version: 3,
  risk: "high",
  side_effect: "irreversible",
  egress: "org_tenant",
  impacts: ["moves_money"],
  args: {
    amount: "Long",
    charge_id: "String",
    reason: "String",
    tags: "Set<String>",
    line_ids: "Set<Long>",
    expedite: "Bool",
    "idempotency-key": "String",
    type: "String",
  },
};

const GET_CHARGE: CedarToolEntry = {
  version: 1,
  risk: "low",
  side_effect: "read",
  egress: "org_tenant",
  impacts: [],
  args: { charge_id: "String" },
};

/** Types `amount` as a String, so it lands in its own argument group. */
const LEDGER: CedarToolEntry = {
  version: 1,
  risk: "medium",
  side_effect: "write",
  egress: "org_tenant",
  impacts: ["moves_money"],
  args: { amount: "String", memo: "String" },
};

const TOOLS: Tools = { billing__create_refund: REFUND, billing__get_charge: GET_CHARGE };
const MIXED: Tools = { ...TOOLS, ledger__adjust: LEDGER };

function rule(overrides: Partial<DecisionRuleLike> & Pick<DecisionRuleLike, "id">): DecisionRuleLike {
  return {
    description: overrides.id,
    capability: "mcp.billing.create_refund",
    effect: "deny",
    ...overrides,
  };
}

function expectValid(tools: Tools, text: string): void {
  const answer = runtime.validate({
    validationSettings: { mode: "strict" },
    schema: writeCedarSchema(tools),
    policies: { staticPolicies: text },
  });
  expect(answer.type).toBe("success");
  if (answer.type === "success") expect(answer.validationErrors).toEqual([]);
}

function decide(
  tools: Tools,
  result: ConvertedRules,
  action: string,
  raw: Record<string, unknown>,
  approval?: { granted: boolean; approvers: number },
): { decision: string; reasons: string[] } {
  const tool = tools[action];
  if (tool === undefined) throw new Error(`No tool ${action}.`);
  // The hook denies a call whose arguments do not match their types.
  const { args, errors } = typedArgs(raw, tool.args);
  if (errors.length > 0) return { decision: "deny", reasons: [] };
  const context = callContext({
    tool: {
      name: action,
      version: tool.version,
      risk: tool.risk,
      side_effect: tool.side_effect,
      egress: tool.egress,
      impacts: tool.impacts,
    },
    args,
    now: NOW,
    tier: "gateway",
    ...(approval !== undefined ? { approval } : {}),
  });
  const answer = runtime.isAuthorized({
    principal: { type: "Agent", id: AGENT.name },
    action: { type: "Action", id: action },
    resource: CALL_RESOURCE,
    context,
    schema: writeCedarSchema(tools),
    validateRequest: true,
    policies: { staticPolicies: { grant: GRANT, ...result.policies } },
    entities: principalEntities(AGENT),
  });
  const verdict = readCedarDecision(answer, result.approval_ids);
  expect(verdict.errors).toEqual([]);
  return { decision: verdict.decision, reasons: verdict.reasons };
}

describe("deny and approval rules", () => {
  const rules = [
    rule({
      id: "refund.approval-over-50",
      description: "A person approves refunds over $50.",
      priority: 50,
      when: { fact: "input.amount", op: "gt", value: 50 },
      effect: "require_approval",
    }),
    rule({
      id: "refund.deny-over-500",
      description: "Deny refunds over $500.",
      priority: 100,
      when: { fact: "input.amount", op: "gt", value: 500 },
    }),
  ];
  const result = convertDecisionRules({ rules, tools: TOOLS });

  it("converts both rules in first-match order", () => {
    expect(result.converted).toEqual(["refund.deny-over-500", "refund.approval-over-50"]);
    expect(result.unconverted).toEqual([]);
    expect(Object.keys(result.policies)).toEqual([
      "rules.refund.deny-over-500",
      "rules.refund.approval-over-50",
    ]);
    expect(result.approval_ids).toEqual(["rules.refund.approval-over-50"]);
  });

  it("writes the approval rule behind the deny rule's guard", () => {
    expect(result.policies["rules.refund.approval-over-50"]).toBe(
      [
        "// A person approves refunds over $50.",
        '@id("rules.refund.approval-over-50")',
        '@decision("require_approval")',
        "forbid (",
        "  principal,",
        '  action in [Action::"billing__create_refund"],',
        "  resource",
        ")",
        "when { context.args has amount && context.args.amount > 50 }",
        "unless { context.approval.granted }",
        'unless { (action in [Action::"billing__create_refund"] && (context.args has amount && context.args.amount > 500)) }',
      ].join("\n") + ";",
    );
    expect(result.policies["rules.refund.deny-over-500"]).not.toContain("unless");
  });

  it("validates against the workspace's schema", () => {
    expectValid(TOOLS, result.text);
  });

  it("splits into one part per policy", () => {
    const parts = runtime.policySetTextToParts(result.text);
    expect(parts.type).toBe("success");
    if (parts.type === "success") {
      expect(parts.policies).toHaveLength(Object.keys(result.policies).length);
    }
  });

  it("denies a refund the deny rule matches, approval or not", () => {
    const denied = { decision: "deny", reasons: ["rules.refund.deny-over-500"] };
    expect(decide(TOOLS, result, "billing__create_refund", { amount: 1000 })).toEqual(denied);
    expect(
      decide(TOOLS, result, "billing__create_refund", { amount: 1000 }, { granted: true, approvers: 1 }),
    ).toEqual(denied);
  });

  it("parks a refund the approval rule matches until a person approves it", () => {
    expect(decide(TOOLS, result, "billing__create_refund", { amount: 100 })).toEqual({
      decision: "require_approval",
      reasons: ["rules.refund.approval-over-50"],
    });
    expect(
      decide(TOOLS, result, "billing__create_refund", { amount: 100 }, { granted: true, approvers: 1 }),
    ).toEqual({ decision: "allow", reasons: ["grant"] });
  });

  it("lets through a call no rule matches", () => {
    expect(decide(TOOLS, result, "billing__create_refund", { amount: 10 }).decision).toBe("allow");
    expect(decide(TOOLS, result, "billing__create_refund", {}).decision).toBe("allow");
    expect(decide(TOOLS, result, "billing__get_charge", { charge_id: "ch_1" }).decision).toBe("allow");
  });

  it("denies an amount sent as a string, which the old evaluator let through", () => {
    expect(decide(TOOLS, result, "billing__create_refund", { amount: "1000" }).decision).toBe("deny");
  });
});

describe("allow rules", () => {
  const result = convertDecisionRules({
    rules: [
      rule({ id: "billing.deny-all", capability: "mcp.billing.*", priority: 10 }),
      rule({
        id: "billing.allow-test",
        priority: 20,
        when: { fact: "input.charge_id", op: "starts_with", value: "ch_test_" },
        effect: "allow",
      }),
    ],
    tools: TOOLS,
  });

  it("count as converted and write no policy", () => {
    expect(result.converted).toEqual(["billing.allow-test", "billing.deny-all"]);
    expect(Object.keys(result.policies)).toEqual(["rules.billing.deny-all"]);
    expect(result.policies["rules.billing.deny-all"]).toContain(
      'unless { (action in [Action::"billing__create_refund"] && (context.args has charge_id && context.args.charge_id like "ch_test_*")) }',
    );
    expectValid(TOOLS, result.text);
  });

  it("decide a call first, so the deny after them does not fire", () => {
    expect(decide(TOOLS, result, "billing__create_refund", { charge_id: "ch_test_1" }).decision).toBe(
      "allow",
    );
    expect(decide(TOOLS, result, "billing__create_refund", { charge_id: "ch_live_1" })).toEqual({
      decision: "deny",
      reasons: ["rules.billing.deny-all"],
    });
  });

  it("guard only the tools they govern", () => {
    expect(decide(TOOLS, result, "billing__get_charge", { charge_id: "ch_test_1" }).decision).toBe(
      "deny",
    );
  });

  it("write a bare scope guard when they carry no condition", () => {
    const shadowed = convertDecisionRules({
      rules: [
        rule({ id: "a.allow", effect: "allow" }),
        rule({ id: "b.deny", capability: "mcp.billing.*" }),
      ],
      tools: TOOLS,
    });
    expect(shadowed.policies["rules.b.deny"]).toContain(
      'unless { action in [Action::"billing__create_refund"] }',
    );
    expectValid(TOOLS, shadowed.text);
    expect(decide(TOOLS, shadowed, "billing__create_refund", {}).decision).toBe("allow");
    expect(decide(TOOLS, shadowed, "billing__get_charge", {}).decision).toBe("deny");
  });
});

describe("capabilities", () => {
  function governed(capability: string): string {
    const result = convertDecisionRules({ rules: [rule({ id: "r", capability })], tools: TOOLS });
    return result.policies["rules.r"]?.split("\n")[4] ?? "none";
  }

  it("match the tool identity mcp.<server>.<tool>", () => {
    expect(governed("*")).toBe(
      '  action in [Action::"billing__create_refund", Action::"billing__get_charge"],',
    );
    expect(governed("mcp.billing.*")).toBe(governed("*"));
    expect(governed("MCP.Billing.Get_Charge")).toBe('  action in [Action::"billing__get_charge"],');
    expect(governed("mcp.billing.get_*")).toBe('  action in [Action::"billing__get_charge"],');
    expect(governed("mcp.billing.get")).toBe("none");
  });

  it("leave a rule over a platform capability unconverted", () => {
    for (const capability of ["refund.create", "Billing.*", "mcp.github.*"]) {
      const result = convertDecisionRules({ rules: [rule({ id: "r", capability })], tools: TOOLS });
      expect(result.unconverted).toEqual([{ id: "r", reason: "It governs no imported tool." }]);
      expect(result.policies).toEqual({});
    }
  });
});

describe("first-match order", () => {
  it("sorts by priority, highest first, then by id", () => {
    const result = convertDecisionRules({
      rules: [rule({ id: "b" }), rule({ id: "a" }), rule({ id: "c", priority: 5 }), rule({ id: "d" })],
      tools: TOOLS,
    });
    expect(result.converted).toEqual(["c", "a", "b", "d"]);
  });
});

describe("unconverted rules", () => {
  const unreadable = "Cedar reads a tool argument as input.<name>, so it cannot read";

  it.each<{ name: string; when: ConditionLike; tools?: Tools; capability?: string; reason: string }>([
    {
      name: "a workspace fact",
      when: { fact: "facts.spend_today_cents", op: "gt", value: 5000 },
      reason: `${unreadable} facts.spend_today_cents.`,
    },
    {
      name: "a call fact",
      when: { fact: "call.cost_cents", op: "gt", value: 5 },
      reason: `${unreadable} call.cost_cents.`,
    },
    {
      name: "a nested argument",
      when: { fact: "input.customer.tier", op: "eq", value: "vip" },
      reason: `${unreadable} input.customer.tier.`,
    },
    {
      name: "the input root alone",
      when: { fact: "input", op: "exists" },
      reason: `${unreadable} input.`,
    },
    {
      name: "an argument no governed tool declares",
      when: { fact: "input.currency", op: "eq", value: "usd" },
      reason:
        "Cedar cannot read input.currency. No tool the rule governs declares it with a type Cedar holds.",
    },
    {
      name: "a name on the object prototype",
      when: { fact: "input.constructor", op: "exists" },
      reason:
        "Cedar cannot read input.constructor. No tool the rule governs declares it with a type Cedar holds.",
    },
    {
      name: "an argument the governed tools type differently",
      when: { fact: "input.amount", op: "gt", value: 5 },
      tools: MIXED,
      capability: "*",
      reason: "The tools the rule governs type input.amount differently.",
    },
    {
      name: "a bound past the whole numbers Cedar reads",
      when: { fact: "input.amount", op: "gt", value: 1e20 },
      reason:
        "The bound in input.amount gt 100000000000000000000 is outside the whole numbers Cedar reads.",
    },
    {
      name: "an operator Cedar has no form for",
      when: { fact: "input.amount", op: "matches" as string as ConditionOpLike, value: 5 },
      reason: "Cedar has no form for the matches operator.",
    },
    {
      name: "a failure inside all",
      when: {
        all: [
          { fact: "input.amount", op: "gt", value: 5 },
          { fact: "facts.region", op: "eq", value: "eu" },
        ],
      },
      reason: `${unreadable} facts.region.`,
    },
    {
      name: "a failure inside not",
      when: { not: { fact: "call.retries", op: "gt", value: 2 } },
      reason: `${unreadable} call.retries.`,
    },
  ])("names $name", ({ when, tools, capability, reason }) => {
    const result = convertDecisionRules({
      rules: [rule({ id: "r", when, ...(capability !== undefined ? { capability } : {}) })],
      tools: tools ?? TOOLS,
    });
    expect(result.unconverted).toEqual([{ id: "r", reason }]);
    expect(result.converted).toEqual([]);
    expect(result.policies).toEqual({});
  });

  it("leave every later rule over the same tools unconverted", () => {
    const result = convertDecisionRules({
      rules: [
        rule({ id: "r1", priority: 10, when: { fact: "facts.spend", op: "gt", value: 1 } }),
        rule({ id: "r2", priority: 5, capability: "mcp.billing.*" }),
        rule({ id: "r3", priority: 1 }),
        rule({ id: "r4", priority: 0, capability: "mcp.billing.get_charge" }),
      ],
      tools: TOOLS,
    });
    expect(result.unconverted).toEqual([
      { id: "r1", reason: `${unreadable} facts.spend.` },
      { id: "r2", reason: "It follows r1, which governs the same tools and did not convert." },
      { id: "r3", reason: "It follows r1, which governs the same tools and did not convert." },
      { id: "r4", reason: "It follows r2, which governs the same tools and did not convert." },
    ]);
  });

  it("leave a later rule over other tools converted", () => {
    const result = convertDecisionRules({
      rules: [
        rule({ id: "r1", priority: 10, when: { fact: "facts.spend", op: "gt", value: 1 } }),
        rule({ id: "r2", priority: 5, capability: "mcp.billing.get_charge" }),
      ],
      tools: TOOLS,
    });
    expect(result.converted).toEqual(["r2"]);
    expect(Object.keys(result.policies)).toEqual(["rules.r2"]);
  });
});

type Case = [args: Record<string, unknown>, fires: boolean];

const OPERATORS: { name: string; when: ConditionLike; cases: Case[] }[] = [
  {
    name: "exists",
    when: { fact: "input.amount", op: "exists" },
    // A null argument reads as absent. The old evaluator matched it.
    cases: [[{ amount: 5 }, true], [{}, false], [{ amount: null }, false]],
  },
  {
    name: "eq on a Long",
    when: { fact: "input.amount", op: "eq", value: 500 },
    cases: [[{ amount: 500 }, true], [{ amount: 499 }, false], [{}, false]],
  },
  {
    name: "eq with a value of another type",
    when: { fact: "input.amount", op: "eq", value: "500" },
    cases: [[{ amount: 500 }, false]],
  },
  {
    name: "eq on a Bool",
    when: { fact: "input.expedite", op: "eq", value: true },
    cases: [[{ expedite: true }, true], [{ expedite: false }, false]],
  },
  {
    name: "eq on a String",
    when: { fact: "input.charge_id", op: "eq", value: "ch_1" },
    cases: [[{ charge_id: "ch_1" }, true], [{ charge_id: "ch_2" }, false]],
  },
  {
    name: "eq on a set",
    when: { fact: "input.tags", op: "eq", value: "vip" },
    cases: [[{ tags: ["vip"] }, false]],
  },
  {
    name: "neq",
    when: { fact: "input.charge_id", op: "neq", value: "ch_1" },
    // A null argument reads as absent. The old evaluator matched it.
    cases: [
      [{ charge_id: "ch_2" }, true],
      [{ charge_id: "ch_1" }, false],
      [{}, false],
      [{ charge_id: null }, false],
    ],
  },
  {
    name: "neq with a value of another type",
    when: { fact: "input.amount", op: "neq", value: "500" },
    cases: [[{ amount: 500 }, true], [{}, false]],
  },
  {
    name: "lt with a fraction",
    when: { fact: "input.amount", op: "lt", value: 10.5 },
    cases: [[{ amount: 10 }, true], [{ amount: 11 }, false]],
  },
  {
    name: "lte with a fraction",
    when: { fact: "input.amount", op: "lte", value: 10.5 },
    cases: [[{ amount: 10 }, true], [{ amount: 11 }, false]],
  },
  {
    name: "gt with a fraction",
    when: { fact: "input.amount", op: "gt", value: 10.5 },
    cases: [[{ amount: 11 }, true], [{ amount: 10 }, false]],
  },
  {
    name: "gte with a fraction",
    when: { fact: "input.amount", op: "gte", value: 10.5 },
    cases: [[{ amount: 11 }, true], [{ amount: 10 }, false]],
  },
  {
    name: "gt with a string bound",
    when: { fact: "input.amount", op: "gt", value: "10" },
    cases: [[{ amount: 11 }, false]],
  },
  {
    name: "gt on a String",
    when: { fact: "input.charge_id", op: "gt", value: 10 },
    cases: [[{ charge_id: "ch_1" }, false]],
  },
  {
    name: "lt with an infinite bound",
    when: { fact: "input.amount", op: "lt", value: Number.POSITIVE_INFINITY },
    cases: [[{ amount: 11 }, false]],
  },
  {
    name: "in on a String",
    when: { fact: "input.charge_id", op: "in", value: ["ch_1", "ch_2", "ch_1", 7] },
    cases: [[{ charge_id: "ch_2" }, true], [{ charge_id: "ch_3" }, false], [{}, false]],
  },
  {
    name: "in on a Long",
    when: { fact: "input.amount", op: "in", value: [1, 2.5, "3"] },
    cases: [[{ amount: 1 }, true], [{ amount: 3 }, false]],
  },
  {
    name: "in with no value of the argument's type",
    when: { fact: "input.charge_id", op: "in", value: [7] },
    cases: [[{ charge_id: "7" }, false]],
  },
  {
    name: "in with a value that is not a list",
    when: { fact: "input.charge_id", op: "in", value: "ch_1" },
    cases: [[{ charge_id: "ch_1" }, false]],
  },
  {
    name: "not_in",
    when: { fact: "input.charge_id", op: "not_in", value: ["ch_1"] },
    cases: [[{ charge_id: "ch_2" }, true], [{ charge_id: "ch_1" }, false], [{}, false]],
  },
  {
    name: "not_in with no value of the argument's type",
    when: { fact: "input.charge_id", op: "not_in", value: [7] },
    cases: [[{ charge_id: "x" }, true], [{}, false]],
  },
  {
    name: "not_in with a value that is not a list",
    when: { fact: "input.charge_id", op: "not_in", value: "ch_1" },
    cases: [[{ charge_id: "ch_2" }, false]],
  },
  {
    name: "contains on a String",
    when: { fact: "input.reason", op: "contains", value: "fraud" },
    cases: [[{ reason: "suspected fraud here" }, true], [{ reason: "damaged" }, false]],
  },
  {
    name: "contains with a star in the value",
    when: { fact: "input.reason", op: "contains", value: "50*off" },
    cases: [[{ reason: "promo 50*off" }, true], [{ reason: "promo 50% off" }, false]],
  },
  {
    name: "contains on a Set<String>",
    when: { fact: "input.tags", op: "contains", value: "vip" },
    cases: [[{ tags: ["vip", "b"] }, true], [{ tags: ["b"] }, false]],
  },
  {
    name: "contains on a Set<Long>",
    when: { fact: "input.line_ids", op: "contains", value: 7 },
    cases: [[{ line_ids: [7, 8] }, true], [{ line_ids: [8] }, false]],
  },
  {
    name: "contains a fraction on a Set<Long>",
    when: { fact: "input.line_ids", op: "contains", value: 7.5 },
    cases: [[{ line_ids: [7, 8] }, false]],
  },
  {
    name: "contains on a Bool",
    when: { fact: "input.expedite", op: "contains", value: true },
    cases: [[{ expedite: true }, false]],
  },
  {
    name: "starts_with",
    when: { fact: "input.charge_id", op: "starts_with", value: "ch_" },
    cases: [[{ charge_id: "ch_1" }, true], [{ charge_id: "re_1" }, false]],
  },
  {
    name: "starts_with on a Long",
    when: { fact: "input.amount", op: "starts_with", value: "1" },
    cases: [[{ amount: 12 }, false]],
  },
  {
    name: "starts_with on a name Cedar must quote",
    when: { fact: "input.idempotency-key", op: "starts_with", value: "k-" },
    cases: [[{ "idempotency-key": "k-1" }, true], [{ "idempotency-key": "x" }, false]],
  },
  {
    name: "eq on a reserved name",
    when: { fact: "input.type", op: "eq", value: "partial" },
    cases: [[{ type: "partial" }, true], [{ type: "full" }, false], [{}, false]],
  },
  {
    name: "starts_with a quote and a backslash",
    when: { fact: "input.reason", op: "starts_with", value: 'say "hi"\\' },
    cases: [[{ reason: 'say "hi"\\ now' }, true], [{ reason: "say hi" }, false]],
  },
  {
    name: "an empty all",
    when: { all: [] },
    cases: [[{}, true]],
  },
  {
    name: "an empty any",
    when: { any: [] },
    cases: [[{ amount: 5 }, false]],
  },
  {
    name: "not",
    when: { not: { fact: "input.amount", op: "exists" } },
    cases: [[{}, true], [{ amount: 1 }, false]],
  },
  {
    name: "any",
    when: {
      any: [
        { fact: "input.charge_id", op: "eq", value: "a" },
        { fact: "input.charge_id", op: "eq", value: "b" },
      ],
    },
    cases: [[{ charge_id: "b" }, true], [{ charge_id: "c" }, false]],
  },
  {
    name: "all with a not inside",
    when: {
      all: [
        { fact: "input.amount", op: "gt", value: 10 },
        { not: { fact: "input.expedite", op: "exists" } },
      ],
    },
    cases: [[{ amount: 11 }, true], [{ amount: 11, expedite: true }, false], [{ amount: 9 }, false]],
  },
];

describe("operators", () => {
  it.each(OPERATORS)("$name decides as the old evaluator did", ({ when, cases }) => {
    const result = convertDecisionRules({ rules: [rule({ id: "r", when })], tools: TOOLS });
    expect(result.unconverted).toEqual([]);
    expectValid(TOOLS, result.text);
    for (const [args, fires] of cases) {
      const { decision } = decide(TOOLS, result, "billing__create_refund", args);
      expect(decision, JSON.stringify(args)).toBe(fires ? "deny" : "allow");
    }
  });

  function whenOf(when: ConditionLike): string | undefined {
    const text = convertDecisionRules({ rules: [rule({ id: "r", when })], tools: TOOLS }).policies[
      "rules.r"
    ];
    // With no unless clause after it, the when line ends with the policy's closing semicolon.
    return text
      ?.split("\n")
      .find((line) => line.startsWith("when"))
      ?.replace(/;$/, "");
  }

  it("round a fractional bound to the whole number that decides the same", () => {
    expect(whenOf({ fact: "input.amount", op: "lt", value: 10.5 })).toContain("context.args.amount < 11");
    expect(whenOf({ fact: "input.amount", op: "lte", value: 10.5 })).toContain(
      "context.args.amount <= 10",
    );
    expect(whenOf({ fact: "input.amount", op: "gt", value: 10.5 })).toContain("context.args.amount > 10");
    expect(whenOf({ fact: "input.amount", op: "gte", value: 10.5 })).toContain(
      "context.args.amount >= 11",
    );
  });

  it("quote a name that is not a Cedar identifier", () => {
    expect(whenOf({ fact: "input.idempotency-key", op: "exists" })).toBe(
      'when { context.args has "idempotency-key" }',
    );
    expect(whenOf({ fact: "input.type", op: "eq", value: "x" })).toBe(
      'when { context.args has "type" && context.args["type"] == "x" }',
    );
  });

  it("escape a like pattern's star, quote, and backslash", () => {
    expect(whenOf({ fact: "input.reason", op: "contains", value: 'a*"\\' })).toBe(
      'when { context.args has reason && context.args.reason like "*a\\*\\"\\\\*" }',
    );
  });

  it("write each value of a list once", () => {
    expect(whenOf({ fact: "input.charge_id", op: "in", value: ["a", "b", "a"] })).toBe(
      'when { context.args has charge_id && ["a", "b"].contains(context.args.charge_id) }',
    );
  });
});

describe("descriptions", () => {
  it("write a multi-line description as one comment line", () => {
    const result = convertDecisionRules({
      rules: [rule({ id: "r", description: "Deny refunds\r\n  over $500.\n" })],
      tools: TOOLS,
    });
    expect(result.policies["rules.r"]?.split("\n")[0]).toBe("// Deny refunds over $500.");
    expectValid(TOOLS, result.text);
  });
});

describe("argument groups", () => {
  it("keep a guard over one group from typechecking against another", () => {
    const result = convertDecisionRules({
      rules: [
        rule({ id: "r1", priority: 10, when: { fact: "input.amount", op: "gt", value: 500 } }),
        rule({
          id: "r2",
          priority: 5,
          capability: "*",
          when: { fact: "input.memo", op: "starts_with", value: "adj" },
          effect: "require_approval",
        }),
      ],
      tools: MIXED,
    });
    expect(result.converted).toEqual(["r1", "r2"]);
    expect(result.policies["rules.r2"]).toContain(
      'unless { (action in [Action::"billing__create_refund"] && (context.args has amount && context.args.amount > 500)) }',
    );
    expectValid(MIXED, result.text);

    expect(decide(MIXED, result, "ledger__adjust", { memo: "adj-1", amount: "12" })).toEqual({
      decision: "require_approval",
      reasons: ["rules.r2"],
    });
    expect(decide(MIXED, result, "ledger__adjust", { memo: "fix" }).decision).toBe("allow");
    expect(
      decide(MIXED, result, "ledger__adjust", { memo: "adj-1" }, { granted: true, approvers: 1 })
        .decision,
    ).toBe("allow");
    expect(decide(MIXED, result, "billing__create_refund", { amount: 600 })).toEqual({
      decision: "deny",
      reasons: ["rules.r1"],
    });
  });
});

describe("an empty rule set", () => {
  it("writes the header and no policy", () => {
    const result = convertDecisionRules({ rules: [], tools: TOOLS });
    expect(result).toMatchObject({ policies: {}, approval_ids: [], converted: [], unconverted: [] });
    const parts = runtime.policySetTextToParts(result.text);
    expect(parts).toMatchObject({ type: "success", policies: [] });
  });
});
