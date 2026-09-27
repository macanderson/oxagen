import { beforeAll, describe, expect, it } from "vitest";
import { evaluatePreToolUse, type EvaluationInput } from "./bundle";
import { bundleSigner, unsignedBundle } from "./test-support";
import { requireCedarRuntime, type CedarRuntime } from "../policy/runtime";
import { TEST_CEDAR_SCHEMA, testCedarBundle } from "../policy/test-schema";
import type { CedarBundle, PolicyBundle } from "../wire";

const NOW = Date.parse("2026-09-22T11:30:00.000Z");

// The release bot (Claude Code) and the CI reviewer (Codex) may not run a
// shell. The docs writer (Stella) may.
const NO_SHELL = {
  "shell.not-for-bots": `@id("shell.not-for-bots")
forbid (principal, action == Action::"builtin__shell", resource)
when {
  principal == Agent::"a-intel.core.release-bot" ||
  principal == Agent::"a-intel.core.ci-reviewer"
};`,
};

// Publishing a package waits for a person.
const PUBLISH_APPROVAL = {
  "publish.approval": `@id("publish.approval")
@decision("require_approval")
forbid (principal, action == Action::"builtin__shell", resource)
when { context.args has command && context.args.command like "npm publish*" };`,
};

const signer = bundleSigner();

function signed(
  cedar: CedarBundle | undefined,
  overrides: Partial<Omit<PolicyBundle, "signature">> = {},
): PolicyBundle {
  return signer.sign(unsignedBundle({ ...(cedar !== undefined ? { cedar } : {}), ...overrides }));
}

let runtime: CedarRuntime;
beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

function input(
  bundle: PolicyBundle,
  overrides: Partial<EvaluationInput> & { harness?: string; agent?: string } = {},
): EvaluationInput {
  const { harness = "claude-code", agent, ...rest } = overrides;
  return {
    bundle,
    bundleVerified: true,
    hostStatus: "active",
    latestDenyGeneration: { org: 1, workspace: 1 },
    controlReachable: true,
    now: NOW,
    context: { cwd: "/repo" },
    toolName: "Bash",
    toolInput: { command: "ls" },
    cedar: { runtime, harness, ...(agent !== undefined ? { agent } : {}) },
    ...rest,
  };
}

describe("PreToolUse with Cedar policies", () => {
  it("denies Claude Code's Bash for an agent a policy forbids the shell", () => {
    expect(evaluatePreToolUse(input(signed(testCedarBundle(NO_SHELL))))).toMatchObject({
      decision: "deny",
      evaluated: "deny",
      source: "bundle",
      rule: "shell.not-for-bots",
      rules: ["shell.not-for-bots"],
      reason_code: "cedar_deny",
    });
  });

  it("denies Codex's shell for an agent a policy forbids the shell", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle(NO_SHELL)), {
        harness: "codex",
        toolName: "shell",
        toolInput: { command: ["bash", "-lc", "ls"] },
      }),
    );
    expect(evaluation).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rules: ["shell.not-for-bots"],
    });
  });

  it("allows the shell for another agent and leaves the prompt to the harness", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle(NO_SHELL)), { harness: "stella", toolName: "bash" }),
    );
    expect(evaluation).toMatchObject({
      decision: "ask",
      evaluated: "ask",
      source: "bundle",
      reason_code: "cedar_allow",
    });
    expect(evaluation.reason).toContain("grant.builtin");
    // No rule, so the hook answers nothing and the harness's own flow decides.
    expect(evaluation.rule).toBeUndefined();
    expect(evaluation.rules).toBeUndefined();
  });

  it("asks when every deciding rule is an approval rule", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle(PUBLISH_APPROVAL, ["publish.approval"])), {
        toolInput: { command: "npm publish --tag next" },
      }),
    );
    expect(evaluation).toMatchObject({
      decision: "ask",
      evaluated: "ask",
      rules: ["publish.approval"],
      reason_code: "cedar_require_approval",
    });
  });

  it("denies a call a forbid and an approval rule both decide", () => {
    const evaluation = evaluatePreToolUse(
      input(
        signed(testCedarBundle({ ...NO_SHELL, ...PUBLISH_APPROVAL }, ["publish.approval"])),
        { toolInput: { command: "npm publish" } },
      ),
    );
    expect(evaluation).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rules: ["publish.approval", "shell.not-for-bots"],
    });
  });

  it("keeps the bundle's deny rules ahead of Cedar", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle({})), { toolInput: { command: "git push origin main" } }),
    );
    expect(evaluation).toMatchObject({ decision: "deny", reason_code: "rule_deny" });
  });

  it("keeps the bundle's ask rules ahead of Cedar's allow", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle({})), { toolInput: { command: "rm build.log" } }),
    );
    expect(evaluation).toMatchObject({ decision: "ask", reason_code: "rule_ask" });
  });

  it("keeps the bundle's allow rules ahead of Cedar's allow", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle({})), { toolInput: { command: "git status" } }),
    );
    expect(evaluation).toMatchObject({ decision: "allow", reason_code: "rule_allow" });
  });

  it("names Cedar's allow for a call no permission rule covers", () => {
    const bundle = signed(testCedarBundle({}));
    expect(evaluatePreToolUse(input(bundle))).toMatchObject({
      decision: "ask",
      reason_code: "cedar_allow",
    });
    expect(
      evaluatePreToolUse(input(signed(testCedarBundle({}), { mode: "observe" }))),
    ).toMatchObject({ decision: "allow", reason_code: "cedar_allow" });
    const { cedar: _cedar, ...withoutCedar } = input(bundle);
    expect(evaluatePreToolUse(withoutCedar)).toMatchObject({
      decision: "ask",
      reason_code: "no_rule",
    });
  });

  it("answers allow in observe mode and records what Cedar said", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle(NO_SHELL), { mode: "observe" })),
    );
    expect(evaluation).toMatchObject({
      decision: "allow",
      evaluated: "deny",
      reason_code: "cedar_deny",
    });
  });

  it("leaves a gateway tool to the permission rules", () => {
    const evaluation = evaluatePreToolUse(
      input(signed(testCedarBundle(NO_SHELL)), { toolName: "mcp__github__get_issue", toolInput: {} }),
    );
    expect(evaluation).toMatchObject({ decision: "allow", reason_code: "rule_allow" });
  });

  it("leaves the call to the permission rules when the bundle has no Cedar part", () => {
    expect(evaluatePreToolUse(input(signed(undefined)))).toMatchObject({
      decision: "ask",
      reason_code: "no_rule",
    });
  });

  it("denies a tool that changes anything when the host has no evaluator", () => {
    const bundle = signed(testCedarBundle({}));
    expect(
      evaluatePreToolUse({ ...input(bundle), cedar: { runtime: null, harness: "claude-code" } }),
    ).toMatchObject({ decision: "deny", reason_code: "cedar_unavailable" });
    expect(
      evaluatePreToolUse({
        ...input(bundle),
        toolName: "Read",
        toolInput: { file_path: "/repo/README.md" },
        cedar: { runtime: null, harness: "claude-code" },
      }),
    ).toMatchObject({ decision: "allow", reason_code: "rule_allow" });
  });

  it("denies a call when no agent on this host runs the harness", () => {
    expect(
      evaluatePreToolUse(input(signed(testCedarBundle({})), { harness: "cursor", toolName: "Shell" })),
    ).toMatchObject({ decision: "deny", reason_code: "cedar_no_agent" });
    expect(
      evaluatePreToolUse(input(signed(testCedarBundle({})), { agent: "a-intel.core.nobody" })),
    ).toMatchObject({ decision: "deny", reason_code: "cedar_no_agent" });
  });

  it("denies a call Cedar cannot decide", () => {
    const cedar = {
      ...testCedarBundle({}),
      schema: TEST_CEDAR_SCHEMA.replace("harness: String\n", "harness: String,\n  team: String\n"),
    };
    expect(evaluatePreToolUse(input(signed(cedar)))).toMatchObject({
      decision: "deny",
      reason_code: "cedar_error",
    });
  });

  it("denies a call when the evaluator throws", () => {
    const throwing = {
      ...runtime,
      isAuthorized: () => {
        throw new Error("wasm trap");
      },
    } as CedarRuntime;
    const evaluation = evaluatePreToolUse({
      ...input(signed(testCedarBundle({}))),
      cedar: { runtime: throwing, harness: "claude-code" },
    });
    expect(evaluation).toMatchObject({ decision: "deny", reason_code: "cedar_error" });
    expect(evaluation.reason).toContain("wasm trap");
  });

  it("passes the skill and the action override through to Cedar", () => {
    const noReleaseSkill = {
      "skill.no-release": `@id("skill.no-release")
forbid (principal, action == Action::"builtin__start_subagent", resource)
when { context has skill && context.skill == "release" };`,
    };
    const bundle = signed(testCedarBundle(noReleaseSkill));
    const start = (skill: string) =>
      evaluatePreToolUse({
        ...input(bundle),
        toolName: "Task",
        toolInput: {},
        cedar: { runtime, harness: "claude-code", skill, action: "builtin__start_subagent" },
      });
    expect(start("release")).toMatchObject({ decision: "deny", rules: ["skill.no-release"] });
    expect(start("docs")).toMatchObject({ decision: "ask", reason_code: "cedar_allow" });
  });
});
