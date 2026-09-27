import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { requireCedarRuntime, type CedarRuntime } from "@oxagen/tacho/policy";
import { compilePolicies, type AgentDeclaration, type CompiledPolicySet } from "./compile";
import { cedarTools, type ManifestToolLike } from "./schema";
import { runPolicyTests } from "./tests";
import { NOW } from "./testing";

const FIXTURES = new URL("../../oxagen/fixtures/steering-repo/", import.meta.url);

function fixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

/** The fixture's `name = "value"` keys, which is all an agent file needs here. */
function tomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of text.matchAll(/^(\w+)\s*=\s*"([^"]*)"/gm)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

function agent(file: string): AgentDeclaration {
  const t = tomlStrings(fixture(`repo/agents/${file}`));
  return {
    name: t["name"] ?? "",
    operator: t["operator"] ?? "",
    runtime: t["runtime"] ?? "",
    harness: t["harness"] ?? "",
  };
}

/** The classification in the fixture's `tools/servers/billing/tools.toml`. */
const BILLING_CLASSES: Record<string, ManifestToolLike["classification"]> = {
  list_charges: { risk: "low", side_effect: "read", egress: "org_tenant", impacts: [] },
  get_charge: { risk: "low", side_effect: "read", egress: "org_tenant", impacts: [] },
  create_refund: { risk: "high", side_effect: "irreversible", egress: "org_tenant", impacts: ["moves_money"] },
  get_refund: { risk: "low", side_effect: "read", egress: "org_tenant", impacts: [] },
  list_refunds: { risk: "low", side_effect: "read", egress: "org_tenant", impacts: [] },
  cancel_refund: { risk: "medium", side_effect: "write", egress: "org_tenant", impacts: [] },
};

interface LockedTool {
  version: number;
  upstream: { inputSchema: Record<string, unknown> };
}

function billingTools(): Record<string, ManifestToolLike> {
  const lock = JSON.parse(fixture("repo/tools/servers/billing/tools.lock.json")) as {
    tools: Record<string, LockedTool>;
  };
  return Object.fromEntries(
    Object.entries(lock.tools).map(([name, tool]) => {
      const classification = BILLING_CLASSES[name];
      if (classification === undefined) throw new Error(`The fixture's tools.toml does not classify ${name}.`);
      return [
        name,
        {
          name: `billing__${name}`,
          version: tool.version,
          definition: { inputSchema: tool.upstream.inputSchema },
          classification,
        },
      ];
    }),
  );
}

let runtime: CedarRuntime;
let policy: CompiledPolicySet;

const WEEKDAYS_ONLY = `@id("refund.weekdays")
forbid (principal, action == Action::"billing__cancel_refund", resource)
unless { context.time.weekday };`;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
  const workspace = tomlStrings(fixture("repo/workspace.toml"))["workspace"] ?? "";
  const { tools, skipped } = cedarTools({ servers: [{ name: "billing", tools: billingTools() }] });
  expect(skipped).toEqual([]);
  const result = compilePolicies(
    {
      workspace,
      agents: [agent("a-intel.core.release-bot.toml"), agent("a-intel.core.ci-reviewer.toml")],
      tools,
      policies: [
        { path: "policy/money.cedar", text: fixture("repo/policy/money.cedar") },
        { path: "policy/weekdays.cedar", text: WEEKDAYS_ONLY },
      ],
    },
    runtime,
  );
  expect(result.errors).toEqual([]);
  if (result.policy_set === undefined) throw new Error("The fixture's policy set did not compile.");
  policy = result.policy_set;
});

function run(jsonl: string, now = NOW) {
  return runPolicyTests(jsonl, { runtime, policy, now });
}

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    name: "case",
    principal: "a-intel.core.release-bot",
    tool: "billing__cancel_refund",
    expect: "allow",
    ...fields,
  });
}

describe("runPolicyTests on the steering repo fixture", () => {
  it("passes the fixture's money tests", () => {
    const outcome = run(fixture("repo/policy/money.tests.jsonl"));
    expect(outcome.errors).toEqual([]);
    expect(outcome.passed).toBe(true);
    expect(outcome.results).toEqual([
      {
        name: "refund under limit",
        line: 1,
        expect: "allow",
        actual: "allow",
        reasons: ["grant.tools.1"],
        passed: true,
        errors: [],
      },
      {
        name: "refund over limit",
        line: 2,
        expect: "require_approval",
        actual: "require_approval",
        reasons: ["refund.over-100"],
        passed: true,
        errors: [],
      },
    ]);
  });

  it("fails the fixture test that expects the wrong decision, on its line", () => {
    const outcome = run(fixture("invalid/compile/policy-test-passes/repo/policy/money.tests.jsonl"));
    expect(outcome.passed).toBe(false);
    expect(outcome.errors).toEqual([]);
    expect(outcome.results.map((r) => [r.line, r.passed, r.actual])).toEqual([
      [1, true, "allow"],
      [2, false, "require_approval"],
    ]);
  });
});

describe("runPolicyTests", () => {
  it("skips blank lines and counts lines from 1", () => {
    const outcome = run(`\n${line({ name: "second" })}\n\n`);
    expect(outcome.results.map((r) => [r.name, r.line])).toEqual([["second", 2]]);
    expect(outcome.passed).toBe(true);
  });

  it.each([
    ["{not json", /^The line is not JSON: /],
    ["[]", /^Expected object, received array$/],
    [line({ expect: undefined }), /^expect: Required$/],
    [line({ expect: "park" }), /^expect: /],
    [line({ tool: "billing create refund" }), /^tool: The tool is "<server>__<tool>" with an optional "@<version>"\.$/],
    [line({ extra: true }), /Unrecognized key/],
    [line({ context: { time: { hour_utc: 24, weekday: true } } }), /^context\.time\.hour_utc: /],
  ])("reports a line it cannot read: %s", (text, message) => {
    const outcome = run(text);
    expect(outcome.passed).toBe(false);
    expect(outcome.results).toEqual([]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.line).toBe(1);
    expect(outcome.errors[0]?.message).toMatch(message);
  });

  it("reports an agent the workspace does not declare", () => {
    const outcome = run(line({ principal: "a-intel.core.nobody" }));
    expect(outcome.errors).toEqual([{ line: 1, message: "The workspace declares no agent named a-intel.core.nobody." }]);
    expect(outcome.passed).toBe(false);
  });

  it("reports a tool the workspace did not import", () => {
    const outcome = run(line({ tool: "jira__create_issue@2" }));
    expect(outcome.errors).toEqual([{ line: 1, message: "The workspace imported no tool named jira__create_issue." }]);
  });

  it("runs a built-in tool the agent's harness reaches", () => {
    const outcome = run(line({ tool: "builtin__shell", context: { args: { command: "ls" } } }));
    expect(outcome.results[0]).toMatchObject({ actual: "allow", reasons: ["grant.builtin.claude-code"], passed: true });
  });

  it("fails a test whose call errored, even when the decision matches", () => {
    const outcome = run(
      line({ tool: "billing__create_refund@3", context: { args: { amount: "64000" } }, expect: "deny" }),
    );
    expect(outcome.results[0]).toMatchObject({
      actual: "deny",
      passed: false,
      errors: ["Argument amount is not a Long."],
    });
    expect(outcome.passed).toBe(false);
  });

  it("sets the clock from context.time, and from now without it", () => {
    const saturday = Date.UTC(2026, 8, 26, 11);
    const outcome = run(
      [
        line({ name: "weekday", context: { time: { hour_utc: 11, weekday: true } } }),
        line({ name: "weekend", context: { time: { hour_utc: 11, weekday: false } }, expect: "deny" }),
        line({ name: "clock", expect: "deny" }),
      ].join("\n"),
      saturday,
    );
    expect(outcome.results.map((r) => [r.name, r.actual, r.reasons])).toEqual([
      ["weekday", "allow", ["grant.tools.1"]],
      ["weekend", "deny", ["refund.weekdays"]],
      ["clock", "deny", ["refund.weekdays"]],
    ]);
    expect(outcome.passed).toBe(true);
  });

  it("carries every context fact into the call", () => {
    const outcome = run(
      line({
        tool: "billing__create_refund@3",
        context: {
          args: { amount: 64000, charge_id: "ch_1" },
          taint: { tainted: true, sources: ["web"] },
          time: { hour_utc: 10, weekday: true },
          rate: { calls_last_hour: 3, calls_last_minute: 1 },
          run: { prior_calls: ["billing__get_charge"], prior_reads: ["ch_1"] },
          operator: { role: "sre" },
          tier: "gateway",
          budget: { remaining_cents: 5000 },
          mandate: { remaining_cents: 100000 },
          approval: { granted: true, approvers: 1 },
          harness_tool: "mcp__billing__create_refund",
          skill: "a-intel.billing.refunds",
        },
      }),
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ actual: "allow", reasons: ["grant.tools.1"], passed: true });
  });
});
