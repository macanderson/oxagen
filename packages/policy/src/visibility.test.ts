import { beforeAll, describe, expect, it } from "vitest";
import { requireCedarRuntime, type CedarRuntime } from "@oxagen/recorder/policy";
import type { CompiledPolicySet } from "./compile";
import { toolVisibility, type VisibilityInput } from "./visibility";
import {
  CI_REVIEWER,
  DOCS_WRITER,
  RELEASE_BOT,
  RELEASE_MANAGER,
  STELLA_CI,
  TRIAGE,
  compileOrThrow,
  specRule,
} from "./testing";

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

function compile(text: string): CompiledPolicySet {
  return compileOrThrow(runtime, { policies: { "policy/rules.cedar": text } });
}

function visibility(
  policy: CompiledPolicySet,
  agent: string,
  action: string,
  extra: Partial<Pick<VisibilityInput, "tier" | "operator_role">> = {},
) {
  return toolVisibility({ runtime, policy, agent, action, ...extra });
}

const VISIBLE = { visible: true, reasons: [], errors: [] };

describe("a tool's visibility", () => {
  it("hides a tool when a rule forbids every call to it", () => {
    const policy = compile(`@id("refund.never")
forbid (principal, action == Action::"stripe__create_refund", resource);`);
    expect(visibility(policy, RELEASE_MANAGER.name, "stripe__create_refund")).toEqual({
      visible: false,
      reasons: ["refund.never"],
      errors: [],
    });
  });

  it("keeps a tool visible when a rule forbids only a refund over $100", () => {
    const policy = compile(`@id("refund.over-100")
forbid (principal, action == Action::"stripe__create_refund", resource)
when { context.args has amount_cents && context.args.amount_cents > 10000 };`);
    expect(visibility(policy, RELEASE_MANAGER.name, "stripe__create_refund")).toEqual(VISIBLE);
  });

  it("keeps a tool visible under an approval rule a grant can lift", () => {
    const policy = compile(specRule("irreversible.approval"));
    expect(visibility(policy, RELEASE_MANAGER.name, "stripe__create_refund")).toEqual(VISIBLE);
  });

  it("keeps a tool visible when every certain deny is an approval rule", () => {
    const policy = compile(specRule("avoid.no-unless"));
    expect(visibility(policy, RELEASE_MANAGER.name, "github__create_release")).toEqual(VISIBLE);
  });

  it("hides a tool when an approval rule and a plain forbid both deny every call", () => {
    const policy = compile([specRule("avoid.no-unless"), specRule("repo.delete-never")].join("\n\n"));
    expect(visibility(policy, RELEASE_MANAGER.name, "github__delete_repository")).toEqual({
      visible: false,
      reasons: ["avoid.no-unless", "repo.delete-never"],
      errors: [],
    });
  });

  it("hides a built-in the agent's harness does not reach", () => {
    const policy = compileOrThrow(runtime, { policies: {} });
    expect(visibility(policy, CI_REVIEWER.name, "builtin__read_file")).toEqual({
      visible: false,
      reasons: [],
      errors: [],
    });
    expect(visibility(policy, RELEASE_BOT.name, "builtin__read_file")).toEqual(VISIBLE);
  });

  it.each([
    ["Claude Code", RELEASE_BOT],
    ["Codex", CI_REVIEWER],
    ["Cursor", TRIAGE],
    ["Stella", STELLA_CI],
  ])("shows builtin__shell to a %s agent the grant reaches", (_label, agent) => {
    const policy = compileOrThrow(runtime, { policies: {} });
    expect(visibility(policy, agent.name, "builtin__shell")).toEqual(VISIBLE);
  });

  it("hides every tool from an agent the workspace does not declare", () => {
    const policy = compileOrThrow(runtime, { policies: {} });
    expect(visibility(policy, "aintel.core.nobody", "stripe__create_refund")).toEqual({
      visible: false,
      reasons: [],
      errors: ["The workspace declares no agent named aintel.core.nobody."],
    });
  });

  it("hides a tool the workspace did not import", () => {
    const policy = compileOrThrow(runtime, { policies: {} });
    expect(visibility(policy, RELEASE_BOT.name, "jira__create_issue")).toEqual({
      visible: false,
      reasons: [],
      errors: ["The workspace imported no tool named jira__create_issue."],
    });
  });

  it("hides a tool from one agent and shows it to another", () => {
    const policy = compile(`@id("docs-writer.no-refunds")
forbid (
  principal == Agent::"aintel.core.docs-writer",
  action == Action::"stripe__create_refund",
  resource
);`);
    expect(visibility(policy, DOCS_WRITER.name, "stripe__create_refund")).toEqual({
      visible: false,
      reasons: ["docs-writer.no-refunds"],
      errors: [],
    });
    expect(visibility(policy, RELEASE_BOT.name, "stripe__create_refund")).toEqual(VISIBLE);
  });

  it("keeps a tool visible under a rule that reads the skill", () => {
    const policy = compile(`@id("reviewer.read-only")
forbid (principal, action, resource)
when {
  context has skill &&
  context.skill == "aintel.platform.code-reviewer" &&
  context.tool.side_effect != "read"
};`);
    expect(visibility(policy, DOCS_WRITER.name, "builtin__write_file")).toEqual(VISIBLE);
    expect(visibility(policy, STELLA_CI.name, "builtin__write_file")).toEqual(VISIBLE);
  });

  it("reads the tier when the caller knows it", () => {
    const policy = compile(specRule("reads.high-risk-routed"));
    expect(visibility(policy, STELLA_CI.name, "snowflake__run_query", { tier: "harness" })).toEqual({
      visible: false,
      reasons: ["reads.high-risk-routed"],
      errors: [],
    });
    expect(visibility(policy, STELLA_CI.name, "snowflake__run_query", { tier: "gateway" })).toEqual(
      VISIBLE,
    );
    expect(visibility(policy, STELLA_CI.name, "snowflake__run_query")).toEqual(VISIBLE);
  });

  it("reads the operator's role when the caller knows it", () => {
    const policy = compile(`@id("pods.sre-only")
forbid (principal, action == Action::"kubernetes__delete_pod", resource)
unless { context.operator.role == "sre" };`);
    const action = "kubernetes__delete_pod";
    expect(visibility(policy, RELEASE_MANAGER.name, action, { operator_role: "developer" })).toEqual({
      visible: false,
      reasons: ["pods.sre-only"],
      errors: [],
    });
    expect(visibility(policy, RELEASE_MANAGER.name, action, { operator_role: "sre" })).toEqual(VISIBLE);
    expect(visibility(policy, RELEASE_MANAGER.name, action)).toEqual(VISIBLE);
  });

  it("keeps a tool visible when a rule reads a fact only some calls carry", () => {
    const policy = compile(specRule("mandate.remaining"));
    expect(visibility(policy, RELEASE_MANAGER.name, "stripe__create_payment")).toEqual(VISIBLE);
  });
});

describe("a tool Cedar cannot evaluate", () => {
  const policy = () =>
    compile(`@id("refund.never")
forbid (principal, action == Action::"stripe__create_refund", resource);`);

  it("hides the tool when the evaluator fails", () => {
    const failing = {
      ...runtime,
      isAuthorizedPartial: () => ({ type: "failure", errors: [{ message: "wasm trap" }] }),
    } as unknown as CedarRuntime;
    const result = toolVisibility({
      runtime: failing,
      policy: policy(),
      agent: RELEASE_MANAGER.name,
      action: "stripe__create_refund",
    });
    expect(result.visible).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.errors).toContain("wasm trap");
  });

  it("hides the tool when a rule errors", () => {
    const erroring = {
      ...runtime,
      isAuthorizedPartial: () => ({
        type: "success",
        response: { decision: null, errored: ["refund.x"], mustBeDetermining: [] },
        warnings: [],
      }),
    } as unknown as CedarRuntime;
    const result = toolVisibility({
      runtime: erroring,
      policy: policy(),
      agent: RELEASE_MANAGER.name,
      action: "stripe__create_refund",
    });
    expect(result.visible).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.errors).toContain("refund.x: Cedar could not evaluate the rule.");
  });
});
