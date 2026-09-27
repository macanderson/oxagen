/**
 * The daemon's hook path with Cedar policies in the signed bundle: a
 * built-in tool and a subagent launch are decided by the steering record's
 * policies, with the agent picked by harness or by custom agent name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { requireCedarRuntime, type CedarRuntime } from "../policy/runtime";
import { testCedarBundle } from "../policy/test-schema";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { SessionRegistry } from "./registry";

const FIXTURES = join(__dirname, "..", "..", "fixtures", "claude-code", "hooks");

const fixture = (name: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as { stdin: Record<string, unknown> })
    .stdin;

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const NO_SHELL = {
  "shell.not-for-bots": `@id("shell.not-for-bots")
forbid (principal, action == Action::"builtin__shell", resource)
when { principal == Agent::"a-intel.core.release-bot" };`,
};

const NO_EXPLORE = {
  "skill.no-explore": `@id("skill.no-explore")
forbid (principal, action == Action::"builtin__start_subagent", resource)
when { context has skill && context.skill == "Explore" };`,
};

let runtime: CedarRuntime;
beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

function daemon(policies: Record<string, string>, loader: boolean = true) {
  const signer = bundleSigner();
  const bundle = signer.sign(unsignedBundle({ cedar: testCedarBundle(policies) }));
  let clock = Date.parse("2026-09-22T11:00:00.000Z");
  const now = () => (clock += 1000);
  const registry = new SessionRegistry({ context: CONTEXT, scope: TEST_ENROLLMENT, now });
  const view: PolicyView = {
    bundle,
    verified: true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
  };
  let loads = 0;
  const deps = {
    registry,
    policy: () => view,
    acknowledge: () => undefined,
    now,
    ...(loader
      ? {
          cedar: async () => {
            loads += 1;
            return runtime;
          },
        }
      : {}),
  };
  return { deps, loads: () => loads };
}

const bash = (command: string) => ({
  ...fixture("04-PreToolUse.json"),
  tool_name: "Bash",
  tool_input: { command },
});

describe("handleHookEvent with Cedar policies", () => {
  it("denies Claude Code's Bash for the agent the policy names", async () => {
    const { deps, loads } = daemon(NO_SHELL);
    await handleHookEvent(fixture("01-SessionStart.json"), {}, deps);
    const tool = await handleHookEvent(bash("ls"), {}, deps);
    expect(loads()).toBeGreaterThan(0);
    expect(tool.response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("shell.not-for-bots"),
      },
    });
    expect(tool.events.at(-1)?.body).toMatchObject({
      policy_decision: "deny",
      policy_reason_code: "cedar_deny",
    });
  });

  it("leaves a permitted call to the harness with no opinion", async () => {
    const { deps } = daemon({});
    await handleHookEvent(fixture("01-SessionStart.json"), {}, deps);
    const tool = await handleHookEvent(bash("ls"), {}, deps);
    expect(tool.response).toEqual({});
    expect(tool.events.at(-1)?.body).toMatchObject({
      policy_reason_code: "cedar_allow",
    });
  });

  it("refuses a mutating call when no evaluator loader is wired", async () => {
    const { deps } = daemon(NO_SHELL, false);
    await handleHookEvent(fixture("01-SessionStart.json"), {}, deps);
    const tool = await handleHookEvent(bash("ls"), {}, deps);
    expect(tool.events.at(-1)?.body).toMatchObject({
      policy_decision: "deny",
      policy_reason_code: "cedar_unavailable",
    });
  });

  it("decides a subagent launch with the subagent's name as its skill", async () => {
    const { deps } = daemon(NO_EXPLORE);
    await handleHookEvent(fixture("01-SessionStart.json"), {}, deps);
    const start = await handleHookEvent(fixture("13-SubagentStart.json"), {}, deps);
    expect(JSON.stringify(start.events)).toContain("cedar_deny");
    expect(start.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("picks a custom agent by its name", async () => {
    const { deps } = daemon(NO_SHELL);
    const docs = "a-intel.core.docs-writer";
    await handleHookEvent(fixture("01-SessionStart.json"), {}, deps, undefined, undefined, docs);
    const allowed = await handleHookEvent(bash("ls"), {}, deps, undefined, undefined, docs);
    expect(allowed.events.at(-1)?.body).toMatchObject({ policy_reason_code: "cedar_allow" });
  });
});
