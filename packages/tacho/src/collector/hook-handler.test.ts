/**
 * The hook contract test (plan PR 3): every recorded Claude Code hook
 * payload goes through `handleHookEvent`, the decisions match the spec's
 * table, and the resulting chains verify.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import { hookInputSchema } from "../claude-code/hooks";
import type { TachoEvent } from "../envelope";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { toProtocolTimestamp } from "../timestamp";
import type { PolicyBundle } from "../wire";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { SessionRegistry } from "./registry";

const FIXTURES = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "claude-code",
  "hooks",
);

interface Fixture {
  name: string;
  env: Record<string, string>;
  stdin: Record<string, unknown>;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      ...(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Omit<
        Fixture,
        "name"
      >),
    }));
}

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

function harness(
  bundleOverrides: Partial<Omit<PolicyBundle, "signature">> = {},
  viewOverrides: Partial<PolicyView> = {},
) {
  const signer = bundleSigner();
  const bundle = signer.sign(unsignedBundle(bundleOverrides));
  let clock = Date.parse("2026-09-10T10:00:00.000Z");
  const now = () => (clock += 1000);
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const view: PolicyView = {
    bundle,
    verified: true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
    ...viewOverrides,
  };
  const delivered: Array<{ id: string; seq: number }> = [];
  const deps = {
    registry,
    policy: () => view,
    onMessageDelivered: (id: string, _uuid: string, seq: number) =>
      delivered.push({ id, seq }),
    now,
  };
  return { registry, view, deps, delivered, now };
}

function chainsOf(events: TachoEvent[]): Map<string, TachoEvent[]> {
  const out = new Map<string, TachoEvent[]>();
  for (const event of events) {
    const list = out.get(event.session_uuid) ?? [];
    list.push(event);
    out.set(event.session_uuid, list);
  }
  return out;
}

describe("handleHookEvent over the recorded session", () => {
  it("answers every fixture per the spec table and chains verify", async () => {
    const { deps, registry } = harness({
      permissions: {
        allow: ["Read", "Bash(echo *)"],
        deny: ["Write(**/probe.txt)"],
        ask: [],
      },
    });
    const all: TachoEvent[] = [];
    const decisions: Record<string, unknown> = {};
    for (const fixture of loadFixtures()) {
      const outcome = await handleHookEvent(fixture.stdin, fixture.env, deps);
      all.push(...outcome.events);
      decisions[fixture.name] = outcome.response;
      expect(outcome.events.length).toBeGreaterThan(0);
    }
    // SessionStart carries the governed context; the digest is chained.
    expect(decisions["01-SessionStart.json"]).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "You are governed by Oxagen.",
      },
    });
    expect(
      all.find((e) => e.kind === "agent_start")?.attrs?.[
        "oxagen.context_digest"
      ],
    ).toMatch(/^sha256:/);
    // Read is allowed by rule: an explicit allow answer.
    expect(decisions["04-PreToolUse.json"]).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    // Bash echo allowed by rule.
    expect(decisions["06-PreToolUse.json"]).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        permissionDecisionReason: "Allowed by Oxagen policy rule Bash(echo *).",
      },
    });
    // Write to probe.txt is denied by rule.
    expect(decisions["09-PreToolUse.json"]).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Denied by Oxagen policy rule Write(**/probe.txt).",
      },
    });
    // Agent has no rule: falls through to Claude Code's own flow.
    expect(decisions["11-PreToolUse.json"]).toEqual({});
    // Telemetry events never decide.
    for (const name of [
      "05-PostToolUse.json",
      "13-SubagentStart.json",
      "16-Stop.json",
      "24-SessionEnd.json",
    ]) {
      expect(decisions[name]).toEqual({});
    }
    // The denied call chained policy_decision + token_denied, no tool_requested.
    const write = all.filter(
      (e) =>
        (e.body as { tool_name?: string }).tool_name === "Write" &&
        e.hook_event_name === "PreToolUse",
    );
    expect(write.map((e) => e.kind)).toEqual([
      "policy_decision",
      "token_denied",
    ]);
    expect(write[0]?.body).toMatchObject({
      policy_decision: "deny",
      policy_rule: "Write(**/probe.txt)",
      policy_source: "bundle",
      risk_grade: "medium",
    });
    // The allowed call chained policy_decision + tool_requested with the same facts.
    const read = all.filter(
      (e) =>
        (e.body as { tool_name?: string }).tool_name === "Read" &&
        e.hook_event_name === "PreToolUse",
    );
    expect(read.map((e) => e.kind)).toEqual([
      "policy_decision",
      "tool_requested",
    ]);
    expect(read[1]?.body).toMatchObject({
      policy_decision: "allow",
      policy_rule: "Read",
      bundle_version: 3,
      bundle_mode: "enforce",
    });
    // The subagent's PreToolUse landed on the child chain with its own decision.
    const chains = chainsOf(all);
    expect(chains.size).toBe(2);
    for (const [, events] of chains) {
      const verification = verifyChain(events, { expectGenesis: true });
      expect(verification.ok).toBe(true);
    }
    const child = [...chains.values()].find(
      (events) => events[0]?.parent_session_uuid !== undefined,
    ) as TachoEvent[];
    expect(child.some((e) => e.kind === "policy_decision")).toBe(true);
    const session = registry.get(
      String((loadFixtures()[0] as Fixture).stdin["session_id"]),
    );
    expect(session?.sealed).toBe(true);
    expect(session?.pid).toBe(59942);
    expect(session?.cwd).toBe("/home/dev/proj");
  });

  it("blocks prompts and tools for a paused session and delivers operator messages", async () => {
    const { deps, registry } = harness();
    const fixtures = loadFixtures();
    const start = fixtures[0] as Fixture;
    await handleHookEvent(start.stdin, start.env, deps);
    const record = registry.get(String(start.stdin["session_id"]));
    if (record === undefined) throw new Error("no record");
    record.control.paused = "review pending";
    const prompt = fixtures[2] as Fixture;
    const blocked = await handleHookEvent(prompt.stdin, prompt.env, deps);
    expect(blocked.response).toEqual({
      decision: "block",
      reason: "This session is paused by its Oxagen operator: review pending",
    });
    expect(blocked.events[0]?.body).toMatchObject({
      policy_decision: "deny",
      policy_reason_code: "session_paused",
    });
    const tool = fixtures[3] as Fixture;
    const denied = await handleHookEvent(tool.stdin, tool.env, deps);
    expect(denied.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(denied.evaluation?.reason_code).toBe("session_paused");
    const permission = await handleHookEvent(
      { ...tool.stdin, hook_event_name: "PermissionRequest" },
      tool.env,
      deps,
    );
    expect(permission.response).toMatchObject({
      hookSpecificOutput: { decision: { behavior: "deny" } },
    });
    record.control.paused = null;
    record.control.messages.push({ id: "cmd_1", text: "Wrap up and stop." });
    const resumed = await handleHookEvent(prompt.stdin, prompt.env, deps);
    expect(resumed.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Wrap up and stop.",
      },
    });
    expect(resumed.events.map((e) => e.kind)).toEqual(
      ["oxagen:command_applied", "turn_end", "turn_start"].filter((k) =>
        resumed.events.some((e) => e.kind === k),
      ),
    );
    expect(resumed.events[0]?.attrs?.["command.id"]).toBe("cmd_1");
    const open = await handleHookEvent(
      { ...tool.stdin, hook_event_name: "PermissionRequest" },
      tool.env,
      deps,
    );
    expect(open.response).toEqual({});
  });

  it("refuses a session on a suspended host and records why", async () => {
    const { deps } = harness({}, { hostStatus: "suspended" });
    const start = loadFixtures()[0] as Fixture;
    const outcome = await handleHookEvent(start.stdin, start.env, deps);
    expect(outcome.response).toEqual({
      continue: false,
      stopReason: "This host is suspended by its Oxagen operator.",
    });
    expect(outcome.events.map((e) => e.kind)).toEqual([
      "agent_start",
      "policy_decision",
    ]);
    expect(outcome.events[1]?.body).toMatchObject({
      policy_reason_code: "host_suspended",
      policy_source: "human",
    });
  });

  it("re-evaluates a stale bundle after a refresh, and fails closed without one", async () => {
    const { deps, view } = harness(
      {},
      { denyGeneration: { org: 5, workspace: 1 } },
    );
    const fixtures = loadFixtures();
    const start = fixtures[0] as Fixture;
    await handleHookEvent(start.stdin, start.env, deps);
    const bash = fixtures[5] as Fixture;
    let refreshed = 0;
    const withRefresh = {
      ...deps,
      refreshBundle: async () => {
        refreshed += 1;
        view.denyGeneration = { org: 1, workspace: 1 };
      },
    };
    const outcome = await handleHookEvent(bash.stdin, bash.env, withRefresh);
    expect(refreshed).toBe(1);
    expect(outcome.evaluation).toMatchObject({
      decision: "ask",
      reason_code: "no_rule",
      stale: false,
    });
    view.denyGeneration = { org: 6, workspace: 1 };
    const closed = await handleHookEvent(bash.stdin, bash.env, deps);
    expect(closed.evaluation).toMatchObject({
      decision: "deny",
      reason_code: "bundle_stale",
    });
    expect(closed.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("marks replayed events and honours the hook's local decision", async () => {
    const { deps } = harness();
    const fixtures = loadFixtures();
    const start = fixtures[0] as Fixture;
    const receivedAt = toProtocolTimestamp(
      Date.parse("2026-09-10T09:00:00.000Z"),
    );
    const outcome = await handleHookEvent(start.stdin, start.env, deps, {
      receivedAt,
    });
    expect(outcome.events[0]?.ts).toBe(receivedAt);
    expect(outcome.events[0]?.attrs).toMatchObject({
      "hook.replayed": "1",
      "hook.received_at": receivedAt,
    });
    const bash = fixtures[5] as Fixture;
    const local = await handleHookEvent(bash.stdin, bash.env, deps, {
      receivedAt,
      evaluation: {
        decision: "deny",
        evaluated: "deny",
        source: "bundle",
        rule: "Bash(echo *)",
        reason_code: "rule_deny",
        reason: "Denied by Oxagen policy rule Bash(echo *).",
        read_only: false,
        stale: false,
        risk_grade: "high",
        bundle_version: 3,
        bundle_mode: "enforce",
      },
    });
    expect(local.events.map((e) => e.kind)).toEqual([
      "policy_decision",
      "token_denied",
    ]);
    expect(local.events[0]?.attrs).toMatchObject({
      "hook.replayed": "1",
      "policy.evaluated": "deny",
    });
  });

  it("rejects a payload that is not a hook", async () => {
    const { deps } = harness();
    await expect(handleHookEvent({ nope: true }, {}, deps)).rejects.toThrow();
    expect(
      hookInputSchema.safeParse({ session_id: "s", hook_event_name: "X" })
        .success,
    ).toBe(true);
  });
});
