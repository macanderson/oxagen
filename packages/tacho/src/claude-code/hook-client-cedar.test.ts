/**
 * The offline hook path with Cedar policies in the cached bundle: a
 * built-in tool is decided by the steering record's policies when the
 * daemon is down, and a missing evaluator refuses a mutating call.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { requireCedarRuntime, type CedarRuntime } from "../policy/runtime";
import { testCedarBundle } from "../policy/test-schema";
import { decideLocally, runTachoHook } from "./hook-client";
import { hookInputSchema } from "./hooks";

const NOW = Date.parse("2026-09-22T11:30:00.000Z");
const signer = bundleSigner();

const NO_SHELL = {
  "shell.not-for-bots": `@id("shell.not-for-bots")
forbid (principal, action == Action::"builtin__shell", resource)
when {
  principal == Agent::"a-intel.core.release-bot" ||
  principal == Agent::"a-intel.core.ci-reviewer"
};`,
};

const NO_RELEASE_SUBAGENT = {
  "skill.no-release": `@id("skill.no-release")
forbid (principal, action == Action::"builtin__start_subagent", resource)
when { context has skill && context.skill == "release" };`,
};

const host = (policies: Record<string, string>) =>
  testHostFile(
    signer,
    signer.sign(unsignedBundle({ cedar: testCedarBundle(policies) })),
  );

const parse = (event: string, extra: Record<string, unknown> = {}) =>
  hookInputSchema.parse({
    session_id: "s",
    hook_event_name: event,
    cwd: "/repo",
    ...extra,
  });

const BASH = parse("PreToolUse", {
  tool_name: "Bash",
  tool_input: { command: "ls" },
});

let runtime: CedarRuntime;
beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

describe("decideLocally with Cedar policies", () => {
  it("denies Claude Code's Bash for an agent the policy names", () => {
    const local = decideLocally(host(NO_SHELL), BASH, NOW, undefined, {
      runtime,
      harness: "claude-code",
    });
    expect(local.evaluation).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rule: "shell.not-for-bots",
    });
    expect(local.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("denies Codex's shell for an agent the policy names", () => {
    const shell = parse("PreToolUse", {
      tool_name: "shell",
      tool_input: { command: ["bash", "-lc", "ls"] },
    });
    const local = decideLocally(host(NO_SHELL), shell, NOW, undefined, {
      runtime,
      harness: "codex",
    });
    expect(local.evaluation?.reason_code).toBe("cedar_deny");
  });

  it("leaves a permitted call to the harness's own permission flow", () => {
    const bash = parse("PreToolUse", {
      tool_name: "bash",
      tool_input: { command: "ls" },
    });
    const local = decideLocally(host(NO_SHELL), bash, NOW, undefined, {
      runtime,
      harness: "stella",
    });
    expect(local.evaluation).toMatchObject({
      decision: "ask",
      reason_code: "cedar_allow",
    });
    expect(local.evaluation?.rule).toBeUndefined();
    expect(local.response).toEqual({});
  });

  it("refuses a mutating call when the evaluator did not load", () => {
    const local = decideLocally(host(NO_SHELL), BASH, NOW, undefined, {
      runtime: null,
      harness: "stella",
    });
    expect(local.evaluation).toMatchObject({
      decision: "deny",
      reason_code: "cedar_unavailable",
    });
  });

  it("refuses a mutating call when the caller passed no evaluator at all", () => {
    const local = decideLocally(host(NO_SHELL), BASH, NOW);
    expect(local.evaluation?.reason_code).toBe("cedar_unavailable");
  });

  it("decides a subagent launch as builtin__start_subagent with its skill", () => {
    const start = (agentType: string) =>
      decideLocally(
        host(NO_RELEASE_SUBAGENT),
        parse("SubagentStart", { agent_type: agentType, agent_id: "a1" }),
        NOW,
        undefined,
        { runtime, harness: "claude-code" },
      );
    expect(start("release").evaluation).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rule: "skill.no-release",
    });
    expect(start("docs").evaluation?.reason_code).toBe("cedar_allow");
  });

  it("picks a custom agent by its name", () => {
    const local = decideLocally(host(NO_SHELL), BASH, NOW, undefined, {
      runtime,
      harness: "claude-code",
      agent: "a-intel.core.docs-writer",
    });
    expect(local.evaluation?.reason_code).toBe("cedar_allow");
    const unknown = decideLocally(host(NO_SHELL), BASH, NOW, undefined, {
      runtime,
      harness: "claude-code",
      agent: "a-intel.core.stranger",
    });
    expect(unknown.evaluation?.reason_code).toBe("cedar_no_agent");
  });

  it("gives Cedar Cursor's own tool name after the adapter renamed it", () => {
    const cedar = testCedarBundle({
      "no-cursor-shell": `@id("no-cursor-shell")
forbid (principal, action, resource)
when { context has harness_tool && context.harness_tool == "Shell" };`,
    });
    cedar.principals.push({
      name: "a-intel.core.editor",
      operator: "mac@a-intel.com",
      runtime: "laptop-7",
      harness: "cursor",
      workspace: "core",
    });
    const cursorHost = testHostFile(signer, signer.sign(unsignedBundle({ cedar })));
    const decide = (extra: Record<string, unknown>) =>
      decideLocally(
        cursorHost,
        parse("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, ...extra }),
        NOW,
        undefined,
        { runtime, harness: "cursor" },
      );
    expect(decide({ cursor_tool_name: "Shell" }).evaluation).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rule: "no-cursor-shell",
    });
    expect(decide({}).evaluation?.reason_code).toBe("cedar_allow");
  });
});

describe("runTachoHook with the daemon down", () => {
  it("loads the evaluator and decides with the bundle's policies", async () => {
    const paths = scratchPaths();
    writeHostFile(paths.hostFile, host(NO_SHELL));
    let loads = 0;
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        session_id: "s",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: "/repo",
      }),
      platform: "linux",
      now: () => NOW,
      cedar: async () => {
        loads += 1;
        return runtime;
      },
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(loads).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("shell.not-for-bots"),
      },
    });
  });

  it("does not load the evaluator for a bundle without Cedar policies", async () => {
    const paths = scratchPaths();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    let loads = 0;
    await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        session_id: "s",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: "/repo",
      }),
      platform: "linux",
      now: () => NOW,
      cedar: async () => {
        loads += 1;
        return runtime;
      },
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(loads).toBe(0);
  });
});
