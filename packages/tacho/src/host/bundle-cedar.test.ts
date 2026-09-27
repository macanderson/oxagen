import { beforeAll, describe, expect, it } from "vitest";
import { evaluatePreToolUse, type EvaluationInput } from "./bundle";
import { bundleSigner, unsignedBundle } from "./test-support";
import { requireCedarRuntime, type CedarRuntime } from "../policy/runtime";
import { REFUND_ACTION, REFUND_TOOL, TEST_CEDAR_SCHEMA, testCedarBundle } from "../policy/test-schema";
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

  it("decides a direct MCP tool the workspace did not import as the shell", () => {
    const mcp = { toolName: "mcp__github__get_issue", toolInput: {} };
    expect(evaluatePreToolUse(input(signed(testCedarBundle(NO_SHELL)), mcp))).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rules: ["shell.not-for-bots"],
    });
    // With no forbid, the bundle's allow rule for mcp__github__* answers.
    expect(evaluatePreToolUse(input(signed(testCedarBundle({})), mcp))).toMatchObject({
      decision: "allow",
      reason_code: "rule_allow",
    });
  });

  it("decides an imported MCP tool from its arguments", () => {
    const refundsOver100 = {
      "refunds.over-100": `@id("refunds.over-100")
forbid (principal, action == Action::"${REFUND_ACTION}", resource)
when { context.args has amount_cents && context.args.amount_cents > 10000 };`,
    };
    const bundle = signed(testCedarBundle(refundsOver100));
    const refund = (amount: unknown) =>
      evaluatePreToolUse(
        input(bundle, {
          toolName: "mcp__billing__create_refund",
          toolInput: { amount_cents: amount, customer: "cus_1" },
        }),
      );
    expect(refund(15000)).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rules: ["refunds.over-100"],
    });
    expect(refund(500)).toMatchObject({ decision: "ask", reason_code: "cedar_allow" });
    const mistyped = refund("15000");
    expect(mistyped).toMatchObject({ decision: "deny", reason_code: "cedar_error" });
    expect(mistyped.reason).toContain("Argument amount_cents is not a Long.");
  });

  it("leaves one of Oxagen's own tools to the kernel", () => {
    expect(
      evaluatePreToolUse(
        input(signed(testCedarBundle(NO_SHELL)), {
          toolName: "mcp__oxagen__query_ontology",
          toolInput: {},
        }),
      ),
    ).toMatchObject({ decision: "ask", reason_code: "no_rule" });
  });

  it("passes the harness's own tool name through to Cedar", () => {
    const noCursorShell = {
      "no-cursor-shell": `@id("no-cursor-shell")
forbid (principal, action, resource)
when { context has harness_tool && context.harness_tool == "Shell" };`,
    };
    const bundle = signed(testCedarBundle(noCursorShell));
    expect(
      evaluatePreToolUse({
        ...input(bundle),
        cedar: { runtime, harness: "claude-code", harness_tool: "Shell" },
      }),
    ).toMatchObject({ decision: "deny", rules: ["no-cursor-shell"] });
    expect(evaluatePreToolUse(input(bundle))).toMatchObject({
      decision: "ask",
      reason_code: "cedar_allow",
    });
  });

  it("denies a tool that changes anything when the host runs another Cedar version", () => {
    const cedar = { ...testCedarBundle({}), cedar_version: "0.0.0" };
    const bash = evaluatePreToolUse(input(signed(cedar)));
    expect(bash).toMatchObject({ decision: "deny", reason_code: "cedar_version_mismatch" });
    expect(bash.reason).toContain("validated with Cedar 0.0.0");
    expect(bash.reason).toContain(`this host runs Cedar ${runtime.getCedarVersion()}`);
    expect(
      evaluatePreToolUse(
        input(signed(cedar), { toolName: "Read", toolInput: { file_path: "/repo/README.md" } }),
      ),
    ).toMatchObject({ decision: "allow", reason_code: "rule_allow" });
  });

  it("denies a tool that changes anything when the evaluator cannot name its version", () => {
    const silent = {
      ...runtime,
      getCedarVersion: () => {
        throw new Error("wasm trap");
      },
    } as CedarRuntime;
    const evaluation = evaluatePreToolUse({
      ...input(signed(testCedarBundle({}))),
      cedar: { runtime: silent, harness: "claude-code" },
    });
    expect(evaluation).toMatchObject({ decision: "deny", reason_code: "cedar_version_mismatch" });
    expect(evaluation.reason).toContain("unknown (wasm trap)");
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

  it("classes an MCP tool by the signed manifest when the host has no evaluator", () => {
    const cedar = testCedarBundle({});
    const noRuntime = { runtime: null, harness: "claude-code" };
    const refund = {
      ...input(signed(cedar)),
      toolName: `mcp__${REFUND_ACTION}`,
      toolInput: { amount: 4000 },
      cedar: noRuntime,
    };
    expect(evaluatePreToolUse(refund)).toMatchObject({
      decision: "deny",
      reason_code: "cedar_unavailable",
    });
    // A name that reads like a lookup does not make a tool a read. The
    // workspace did not import this one, so it is decided as the shell.
    const getAndDelete = { ...refund, toolName: "mcp__billing__get_and_delete", toolInput: {} };
    expect(evaluatePreToolUse(getAndDelete)).toMatchObject({
      decision: "deny",
      reason_code: "cedar_unavailable",
    });
    // Imported and signed as irreversible, it is still not a read.
    const imported = signed({
      ...cedar,
      tools: { ...cedar.tools, billing__get_and_delete: { ...REFUND_TOOL } },
    });
    expect(evaluatePreToolUse({ ...getAndDelete, bundle: imported })).toMatchObject({
      decision: "deny",
      reason_code: "cedar_unavailable",
    });
    // The manifest's own class decides: the same tool, signed as a read, falls
    // through to the permission rules.
    const lookup = signed({
      ...cedar,
      tools: { [REFUND_ACTION]: { ...REFUND_TOOL, side_effect: "read" } },
    });
    expect(evaluatePreToolUse({ ...refund, bundle: lookup })).toMatchObject({
      decision: "ask",
      reason_code: "no_rule",
    });
    // Oxagen's own tools are the kernel's to decide.
    expect(
      evaluatePreToolUse({ ...refund, toolName: "mcp__oxagen__steering_status", toolInput: {} }),
    ).toMatchObject({ decision: "ask", reason_code: "no_rule" });
  });

  it("decides a harness tool no map names as the shell when the host has no evaluator", () => {
    const bundle = signed(testCedarBundle({}));
    // Claude Code's map does not name TodoWrite.
    expect(
      evaluatePreToolUse({
        ...input(bundle),
        toolName: "TodoWrite",
        toolInput: { todos: [] },
        cedar: { runtime: null, harness: "claude-code" },
      }),
    ).toMatchObject({ decision: "deny", reason_code: "cedar_unavailable" });
    // No map covers this harness, so even Read is decided as the shell.
    expect(
      evaluatePreToolUse({
        ...input(bundle),
        toolName: "Read",
        toolInput: { file_path: "/repo/README.md" },
        cedar: { runtime: null, harness: "gemini-cli" },
      }),
    ).toMatchObject({ decision: "deny", reason_code: "cedar_unavailable" });
  });

  it("classes an MCP tool by the signed manifest when the host runs another Cedar version", () => {
    const cedar = { ...testCedarBundle({}), cedar_version: "0.0.0" };
    const refund = input(signed(cedar), {
      toolName: `mcp__${REFUND_ACTION}`,
      toolInput: { amount_cents: 4000, customer: "cus_1" },
    });
    expect(evaluatePreToolUse(refund)).toMatchObject({
      decision: "deny",
      reason_code: "cedar_version_mismatch",
    });
    const lookup = signed({
      ...cedar,
      tools: { [REFUND_ACTION]: { ...REFUND_TOOL, side_effect: "read" } },
    });
    expect(evaluatePreToolUse({ ...refund, bundle: lookup })).toMatchObject({
      decision: "ask",
      reason_code: "no_rule",
    });
  });

  it("holds back a stale bundle's MCP tool that only its name calls a read", () => {
    // The stale set permits the tool. A forbid published after it would not
    // reach this host, so the call must not run on the stale set's word.
    const fresh = testCedarBundle({});
    const cedar = {
      ...fresh,
      schema: TEST_CEDAR_SCHEMA.replace(
        `"${REFUND_ACTION}"\n`,
        `"${REFUND_ACTION}", "billing__get_and_delete"\n`,
      ),
      tools: { ...fresh.tools, billing__get_and_delete: { ...REFUND_TOOL } },
    };
    const stale = {
      ...input(signed(cedar)),
      latestDenyGeneration: { org: 2, workspace: 1 },
    };
    const getAndDelete = { ...stale, toolName: "mcp__billing__get_and_delete", toolInput: {} };
    expect(evaluatePreToolUse({ ...getAndDelete, controlReachable: false })).toMatchObject({
      decision: "deny",
      reason_code: "bundle_stale",
      stale: true,
    });
    expect(evaluatePreToolUse(getAndDelete)).toMatchObject({
      decision: "defer",
      reason_code: "bundle_stale",
      stale: true,
    });
    // The fresh bundle lets Cedar decide the same call.
    expect(
      evaluatePreToolUse({ ...getAndDelete, latestDenyGeneration: { org: 1, workspace: 1 } }),
    ).toMatchObject({ decision: "ask", reason_code: "cedar_allow" });
    // A built-in the table classes as a read still runs on a stale bundle.
    expect(
      evaluatePreToolUse({
        ...stale,
        controlReachable: false,
        toolName: "Read",
        toolInput: { file_path: "/repo/README.md" },
      }),
    ).toMatchObject({ decision: "allow", reason_code: "rule_allow", stale: true });
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
