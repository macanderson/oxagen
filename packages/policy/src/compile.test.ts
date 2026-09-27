import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { CedarToolEntry } from "@oxagen/tacho";
import { requireCedarRuntime, type CedarRuntime } from "@oxagen/tacho/policy";
import {
  MAX_POLICIES,
  MAX_POLICY_TEXT,
  MAX_TOOLS,
  compilePolicies,
  grantPolicies,
  hostCedarBundle,
  type AgentDeclaration,
  type CompileInput,
  type CompileResult,
} from "./compile";
import { writeCedarSchema } from "./schema";
import {
  CORE,
  CORE_AGENTS,
  COST_ANALYST,
  DOCS_WRITER,
  RELEASE_BOT,
  SPEC_RULES,
  SPEC_TOOLS,
  TRIAGE,
  compileOrThrow,
  specRule,
} from "./testing";

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

const FIXTURES = new URL("../../oxagen/fixtures/steering-repo/", import.meta.url);

function fixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

function compile(
  policies: Readonly<Record<string, string>>,
  overrides: Partial<Omit<CompileInput, "policies">> = {},
): CompileResult {
  return compilePolicies(
    {
      workspace: CORE,
      agents: CORE_AGENTS,
      tools: SPEC_TOOLS,
      ...overrides,
      policies: Object.entries(policies).map(([path, text]) => ({ path, text })),
    },
    runtime,
  );
}

describe("the grant", () => {
  it("permits the workspace's tools and each harness's built-ins", () => {
    const set = compileOrThrow(runtime, { policies: {} });
    expect(Object.keys(set.policies)).toEqual([
      "grant.tools.1",
      "grant.builtin.claude-code",
      "grant.builtin.codex",
      "grant.builtin.cursor",
      "grant.builtin.stella",
    ]);
    const tools = set.policies["grant.tools.1"];
    expect(tools).toContain('principal in Workspace::"core-platform"');
    for (const action of Object.keys(SPEC_TOOLS)) expect(tools).toContain(`Action::"${action}"`);
    expect(set.policies["grant.builtin.codex"]).toContain('Action::"builtin__shell"');
    expect(set.policies["grant.builtin.codex"]).toContain('when { principal.harness == "codex" }');
    expect(set.approval_ids).toEqual([]);
    expect(set.cedar_version).toBe(runtime.getCedarVersion());
    expect(set.schema).toBe(writeCedarSchema(SPEC_TOOLS));
    expect(set.principals.map((p) => p.name)).toEqual(CORE_AGENTS.map((a) => a.name));
    expect(set.principals.every((p) => p.workspace === CORE)).toBe(true);
  });

  it("splits the tool grant so no policy passes the size limit", () => {
    const tools = Array.from({ length: 1000 }, (_, i) => `server__${"x".repeat(80)}_${String(i).padStart(4, "0")}`);
    const grants = grantPolicies(CORE, tools, []);
    expect(Object.keys(grants)).toEqual(["grant.tools.1", "grant.tools.2"]);
    const texts = Object.values(grants);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(MAX_POLICY_TEXT);
    for (const tool of tools) {
      expect(texts.filter((text) => text.includes(`Action::"${tool}"`))).toHaveLength(1);
    }
  });

  it("writes one built-in grant per harness, and only builtin__shell for a harness it does not map", () => {
    const grants = grantPolicies(CORE, [], ["codex", "my-harness", "codex"]);
    expect(Object.keys(grants)).toEqual(["grant.builtin.codex", "grant.builtin.my-harness"]);
    expect(grants["grant.builtin.my-harness"]).toContain('action in [Action::"builtin__shell"]');
  });

  it("escapes a workspace id in the grant", () => {
    const grants = grantPolicies('core "platform"', ["a__b"], []);
    expect(grants["grant.tools.1"]).toContain('principal in Workspace::"core \\"platform\\""');
  });
});

describe("the steering repo's rules", () => {
  it("validates every rule in the spec's examples in strict mode", () => {
    const result = compile({ "policy/spec.cedar": Object.values(SPEC_RULES).join("\n\n") });
    expect(result.errors).toEqual([]);
    expect(result.policy_set?.approval_ids).toEqual([
      "avoid.no-unless",
      "irreversible.approval",
      "payments.two-approvers",
      "refund.over-500",
      "slack.external-approval",
      "taint.write-approval",
      "workflows.approval",
    ]);
    for (const id of Object.keys(SPEC_RULES)) expect(result.policy_set?.policies[id]).toContain(`@id("${id}")`);
  });

  it("gives a rule with no @id its path and place in the file", () => {
    const text = Array.from(
      { length: 12 },
      (_, i) =>
        `forbid (principal, action == Action::"slack__post_message", resource)\nwhen { context.rate.calls_last_hour >= ${i + 1} };`,
    ).join("\n\n");
    const set = compileOrThrow(runtime, { policies: { "policy/rate.cedar": text } });
    for (let k = 1; k <= 12; k++) {
      expect(set.policies[`policy/rate.cedar#${k}`]).toContain(`>= ${k} }`);
    }
  });

  it("refuses an id the grant uses", () => {
    const result = compile({ "policy/mine.cedar": `@id("grant.mine")\nforbid (principal, action, resource);` });
    expect(result.policy_set).toBeUndefined();
    expect(result.errors).toContainEqual({
      path: "policy/mine.cedar",
      policy_id: "grant.mine",
      message: 'Ids that start with "grant." belong to the compiled grant. Choose another id.',
    });
  });

  it("refuses an id two rules share", () => {
    const rule = `@id("refund.never")\nforbid (principal, action == Action::"stripe__create_refund", resource);`;
    const result = compile({ "policy/a.cedar": rule, "policy/b.cedar": rule });
    expect(result.errors).toContainEqual({
      path: "policy/b.cedar",
      policy_id: "refund.never",
      message: "The id refund.never is already used in policy/a.cedar.",
    });
  });

  it("refuses a policy template", () => {
    const result = compile({
      "policy/template.cedar": `@id("t")\npermit (principal == ?principal, action, resource);`,
    });
    expect(result.errors).toContainEqual({
      path: "policy/template.cedar",
      message: "A policy template has no place in the steering repo. Write each rule as a policy.",
    });
  });

  it("refuses @decision on a permit and a @decision value other than require_approval", () => {
    const result = compile({
      "policy/decision.cedar": `@id("p")
@decision("require_approval")
permit (principal, action, resource);

@id("f")
@decision("deny")
forbid (principal, action, resource);`,
    });
    expect(result.errors).toContainEqual({
      path: "policy/decision.cedar",
      policy_id: "p",
      message: '@decision("require_approval") marks a forbid. A permit cannot park a call.',
    });
    expect(result.errors).toContainEqual({
      path: "policy/decision.cedar",
      policy_id: "f",
      message: '@decision takes one value, "require_approval".',
    });
  });

  it("refuses a policy past the size limit", () => {
    const result = compile({
      "policy/long.cedar": `@id("long")\nforbid (principal, action, resource)\nwhen { context.tier == "${"x".repeat(MAX_POLICY_TEXT)}" };`,
    });
    const problem = result.errors.find((e) => e.policy_id === "long");
    expect(problem?.message).toMatch(new RegExp(`^The policy is \\d+ characters\\. The limit is ${MAX_POLICY_TEXT}\\.$`));
  });

  it("refuses a set with more policies than the bundle carries", () => {
    const grants = 5;
    const text = Array.from(
      { length: MAX_POLICIES - grants + 1 },
      (_, i) => `forbid (principal, action == Action::"slack__post_message", resource)\nwhen { context.rate.calls_last_hour >= ${i} };`,
    ).join("\n");
    const result = compile({ "policy/many.cedar": text });
    expect(result.errors).toContainEqual({
      message: `The set holds ${MAX_POLICIES + 1} policies. The limit is ${MAX_POLICIES}.`,
    });
  });

  it("refuses a workspace with more tools than the bundle carries", () => {
    const entry: CedarToolEntry = {
      version: 1,
      risk: "low",
      side_effect: "read",
      egress: "local",
      impacts: [],
      args: {},
    };
    const tools = Object.fromEntries(Array.from({ length: MAX_TOOLS + 1 }, (_, i) => [`t__tool_${i}`, entry]));
    const result = compile({}, { tools });
    expect(result.errors).toContainEqual({
      message: `The workspace imports ${MAX_TOOLS + 1} tools. The limit is ${MAX_TOOLS}.`,
    });
  });

  it("refuses a rule that reads an optional argument without has", () => {
    const result = compile({
      "policy/unsafe.cedar": `@id("refund.unsafe")
forbid (principal, action == Action::"stripe__create_refund", resource)
when { context.args.amount_cents > 50000 };`,
    });
    expect(result.policy_set).toBeUndefined();
    expect(result.schema).toBe(writeCedarSchema(SPEC_TOOLS));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.policy_id === "refund.unsafe" && e.path === "policy/unsafe.cedar")).toBe(true);
  });

  it("refuses the steering repo fixture's rule over an action the schema lacks", () => {
    const path = "policy/unknown-action.cedar";
    const result = compile({ [path]: fixture(`invalid/compile/policy-validates/repo/${path}`) });
    expect(result.policy_set).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.policy_id === "invoice.void-never" && e.path === path)).toBe(true);
  });

  it("refuses the steering repo fixture's rule that does not parse", () => {
    const path = "policy/broken.cedar";
    const result = compile({ [path]: fixture(`invalid/compile/policy-parses/repo/${path}`) });
    expect(result.policy_set).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => e.path === path)).toBe(true);
  });
});

describe("the workspace's agents", () => {
  it("refuses two agents with one name", () => {
    const result = compile({}, { agents: [RELEASE_BOT, RELEASE_BOT] });
    expect(result.errors).toEqual([
      {
        path: "agents/aintel.core.release-bot.toml",
        message: "Two agents are named aintel.core.release-bot.",
      },
    ]);
  });

  it("refuses an agent the bundle cannot carry", () => {
    const nameless: AgentDeclaration = { ...RELEASE_BOT, operator: "" };
    const result = compile({}, { agents: [nameless] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("agents/aintel.core.release-bot.toml");
    expect(result.errors[0]?.message).toMatch(/^operator: /);
  });
});

describe("hostCedarBundle", () => {
  it("carries the whole set and only the agents on one host", () => {
    const set = compileOrThrow(runtime, { policies: { "policy/spec.cedar": specRule("irreversible.approval") } });
    const bundle = hostCedarBundle(set, "laptop-7");
    expect(bundle?.principals.map((p) => p.name)).toEqual([DOCS_WRITER.name, TRIAGE.name, COST_ANALYST.name]);
    expect(bundle?.policies).toEqual(set.policies);
    expect(bundle?.approval_ids).toEqual(["irreversible.approval"]);
    expect(bundle?.schema).toBe(set.schema);
    expect(bundle?.tools).toEqual(set.tools);
    expect(bundle?.cedar_version).toBe(set.cedar_version);
  });

  it("gives nothing for a host no agent runs on", () => {
    const set = compileOrThrow(runtime, { policies: {} });
    expect(hostCedarBundle(set, "nowhere")).toBeUndefined();
  });
});
