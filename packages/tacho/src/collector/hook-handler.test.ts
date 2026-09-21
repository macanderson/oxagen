/**
 * The hook contract test (plan PR 3): every recorded Claude Code hook
 * payload goes through `handleHookEvent`, the decisions match the spec's
 * table, and the resulting chains verify.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes, digestJcs, type JsonValue } from "../digest";
import { translateCursorPayload } from "../claude-code/cursor-adapter";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import { hookInputSchema } from "../claude-code/hooks";
import { stellaToolUseId } from "../claude-code/stella-adapter";
import type { TachoEvent } from "../envelope";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { toProtocolTimestamp } from "../timestamp";
import type { CommandAcknowledgement, PolicyBundle } from "../wire";
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
  const acks: CommandAcknowledgement[] = [];
  const deps = {
    registry,
    policy: () => view,
    acknowledge: (ack: CommandAcknowledgement) => acks.push(ack),
    now,
  };
  return { registry, view, deps, acks, now };
}

/** The tool-use id the events carry, whichever kind ended up holding it. */
function toolUseIdOf(events: TachoEvent[]): string | undefined {
  for (const event of events) {
    const id = (event.body as Record<string, unknown>)["tool_use_id"];
    if (typeof id === "string") return id;
  }
  return undefined;
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
    const { deps, registry, acks } = harness();
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
    record.control.messages.push(
      {
        id: "cmd_1",
        text: "Wrap up and stop.",
        command: "message",
        requestedMode: null,
        deliveryMode: null,
        degradedReason: null,
        expiresAt: null,
      },
      {
        id: "cmd_2",
        text: "Use the staging database.",
        command: "steer",
        requestedMode: "interrupt",
        deliveryMode: "next_step",
        degradedReason: "harness_tier",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    );
    const resumed = await handleHookEvent(prompt.stdin, prompt.env, deps);
    expect(resumed.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Wrap up and stop.\n\nUse the staging database.",
      },
    });
    expect(resumed.events.map((e) => e.kind)).toEqual(
      [
        "oxagen:command_applied",
        "oxagen:command_applied",
        "turn_end",
        "turn_start",
      ].filter((k) => resumed.events.some((e) => e.kind === k)),
    );
    expect(resumed.events[0]?.attrs).toMatchObject({
      "command.id": "cmd_1",
      "command.name": "message",
      "command.interrupted": "0",
    });
    expect(resumed.events[0]?.attrs).not.toHaveProperty(
      "command.requested_mode",
    );
    // The control.steer frame (spec §8.2) in the wrapper vocabulary: both
    // modes, the degradation, and never interrupted at the hook adapter.
    expect(resumed.events[1]?.attrs).toMatchObject({
      "command.id": "cmd_2",
      "command.name": "steer",
      "command.requested_mode": "interrupt",
      "command.delivery_mode": "next_step",
      "command.degraded_reason": "harness_tier",
      "command.interrupted": "0",
    });
    expect(
      (resumed.events[1]?.body as { policy_reason_code?: string })
        .policy_reason_code,
    ).toBe("steer_delivered");
    // Each injected item is acknowledged `applied` with its own frame.
    expect(acks).toEqual([
      {
        command_id: "cmd_1",
        status: "applied",
        session_uuid: record.recorder.sessionUuid,
        applied_at_seq: resumed.events[0]?.seq,
      },
      {
        command_id: "cmd_2",
        status: "applied",
        session_uuid: record.recorder.sessionUuid,
        applied_at_seq: resumed.events[1]?.seq,
      },
    ]);
    const open = await handleHookEvent(
      { ...tool.stdin, hook_event_name: "PermissionRequest" },
      tool.env,
      deps,
    );
    expect(open.response).toEqual({});
  });

  it("drops a queued steer whose expiry passed while it waited: no injection, no frame, an expired ack", async () => {
    // The sequence the delivery report must stay honest over: a steer is
    // received while the session is paused, its expiry passes, the session
    // resumes. The row is the host's, so the host records `expired`; the
    // boundary must not put the text in front of the model and chain a
    // frame that says it did.
    const { deps, registry, acks } = harness();
    const fixtures = loadFixtures();
    const start = fixtures[0] as Fixture;
    await handleHookEvent(start.stdin, start.env, deps);
    const record = registry.get(String(start.stdin["session_id"]));
    if (record === undefined) throw new Error("no record");
    record.control.messages.push(
      {
        id: "cmd_stale",
        text: "Use the staging database.",
        command: "steer",
        requestedMode: "next_step",
        deliveryMode: "next_step",
        degradedReason: null,
        expiresAt: "2026-09-10T09:00:00.000Z",
      },
      {
        id: "cmd_live",
        text: "Wrap up and stop.",
        command: "message",
        requestedMode: null,
        deliveryMode: null,
        degradedReason: null,
        expiresAt: "2026-09-10T11:00:00.000Z",
      },
    );
    const prompt = fixtures[2] as Fixture;
    const outcome = await handleHookEvent(prompt.stdin, prompt.env, deps);
    expect(outcome.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Wrap up and stop.",
      },
    });
    const applied = outcome.events.filter(
      (e) => e.kind === "oxagen:command_applied",
    );
    expect(applied.map((e) => e.attrs?.["command.id"])).toEqual(["cmd_live"]);
    expect(acks).toEqual([
      {
        command_id: "cmd_stale",
        status: "expired",
        session_uuid: record.recorder.sessionUuid,
        detail: "expired before a boundary",
      },
      {
        command_id: "cmd_live",
        status: "applied",
        session_uuid: record.recorder.sessionUuid,
        applied_at_seq: applied[0]?.seq,
      },
    ]);
    expect(record.control.messages).toEqual([]);
    expect(
      verifyChain(record.recorder.sealedEvents, { expectGenesis: true })
        .violations,
    ).toEqual([]);
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

  it("allows a subagent start on a bundle the daemon keeps confirming", async () => {
    // The daemon records a confirmation on every `not_modified`, and the
    // staleness window is measured from that rather than from `issued_at`.
    // This path built its two evaluations by hand and left the field out of
    // both, so past the bundle's signed lifetime every Cursor subagent
    // launch was denied `bundle_stale` on a host whose policy was being
    // confirmed the whole time — in enforce mode, on a live machine.
    const { deps } = harness(
      {
        issued_at: "2026-09-08T00:00:00.000Z",
        expires_at: "2026-09-09T00:00:00.000Z",
        // Staleness only defers a tool that can change something, and the
        // default fixture leaves `Task` out of the tool map, where it reads
        // as read-only.
        tools: { Task: { risk_grade: "high", read_only: false } },
      },
      { mandateConfirmedAt: Date.parse("2026-09-10T09:55:00.000Z") },
    );
    const sub = loadFixtures().find(
      (f) => f.name === "13-SubagentStart.json",
    ) as Fixture;
    const outcome = await handleHookEvent(sub.stdin, sub.env, deps);
    expect(outcome.evaluation?.reason_code).not.toBe("bundle_stale");
    expect(outcome.evaluation?.decision).not.toBe("deny");
  });

  it("evaluates a subagent start on the same confirmation time as its parent", async () => {
    // Freshness is measured from the last control-plane confirmation, and the
    // subagent must read the same one the parent does. It did not: this path
    // built its two evaluations by hand and left `mandateConfirmedAt` out of
    // both, so past the bundle's signed lifetime the parent's `Task` call was
    // fresh and the subagent's was stale. A record that says the subagent ran
    // under a mandate the parent would have been refused under, or the
    // reverse, describes something enforcement did not do.
    const bundle = {
      issued_at: "2026-09-08T00:00:00.000Z",
      expires_at: "2026-09-09T00:00:00.000Z",
      // Staleness only defers a tool that can change something.
      tools: { Task: { risk_grade: "high" as const, read_only: false } },
    };
    const confirmed = {
      mandateConfirmedAt: Date.parse("2026-09-10T09:55:00.000Z"),
    };
    const parentFixture = loadFixtures().find(
      (f) => f.name === "04-PreToolUse.json",
    ) as Fixture;
    // The parent's own `Task` call: the same tool, so the only thing the two
    // evaluations can disagree about is the freshness they were handed.
    const parentInput = {
      ...parentFixture.stdin,
      tool_name: "Task",
      tool_input: { subagent_type: "explore" },
    };
    const sub = loadFixtures().find(
      (f) => f.name === "13-SubagentStart.json",
    ) as Fixture;
    const parent = await handleHookEvent(
      parentInput,
      parentFixture.env,
      harness(bundle, confirmed).deps,
    );
    const child = await handleHookEvent(
      sub.stdin,
      sub.env,
      harness(bundle, confirmed).deps,
    );
    expect(child.evaluation?.stale).toBe(parent.evaluation?.stale);
    expect(child.evaluation?.reason_code).toBe(parent.evaluation?.reason_code);
    expect(child.evaluation?.decision).toBe(parent.evaluation?.decision);
    expect(child.evaluation?.stale).toBe(false);
  });

  it("refuses a Cursor subagent start on a paused host", async () => {
    const { deps } = harness({}, { hostStatus: "paused" });
    const sub = loadFixtures().find((f) => f.name === "13-SubagentStart.json");
    expect(sub).toBeDefined();
    const outcome = await handleHookEvent(
      (sub as Fixture).stdin,
      (sub as Fixture).env,
      deps,
    );
    expect(outcome.response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/paused/),
      },
    });
    expect(outcome.evaluation?.decision).toBe("deny");
  });

  it("refuses a subagent start on a suspended or revoked host and for a paused or cancelled session", async () => {
    const sub = loadFixtures().find(
      (f) => f.name === "13-SubagentStart.json",
    ) as Fixture;
    for (const status of ["suspended", "revoked"] as const) {
      const { deps } = harness({}, { hostStatus: status });
      const outcome = await handleHookEvent(sub.stdin, sub.env, deps);
      expect(outcome.response).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(status),
        },
      });
      expect(outcome.evaluation?.reason_code).toBe(`host_${status}`);
    }
    // Session state is the operator's other stop, and it reaches the same
    // deny: an empty answer would translate to allow for Cursor.
    for (const field of ["paused", "cancelled"] as const) {
      const { deps, registry } = harness();
      const start = loadFixtures()[0] as Fixture;
      await handleHookEvent(start.stdin, start.env, deps);
      const record = registry.get(String(start.stdin["session_id"]));
      if (record === undefined) throw new Error("no record");
      record.control[field] = "operator said stop";
      const outcome = await handleHookEvent(sub.stdin, sub.env, deps);
      expect(outcome.response).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(outcome.evaluation?.reason_code).toBe(`session_${field}`);
    }
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

  it("labels a Codex session by its harness, across a restart, and accepts a null transcript", async () => {
    const { deps, registry, now } = harness();
    const start = {
      session_id: "codex-1",
      hook_event_name: "SessionStart",
      cwd: "/repo",
      transcript_path: null,
      permission_mode: "default",
    };
    const outcome = await handleHookEvent(start, {}, deps, undefined, "codex");
    const agent = outcome.events[0]?.agent as {
      harness: string;
      runtime: string;
    };
    expect(agent).toMatchObject({ harness: "codex", runtime: "codex" });
    expect(registry.get("codex-1")?.harness).toBe("codex");
    expect(registry.get("codex-1")?.transcriptPath).toBeUndefined();

    // A Claude Code session in the same daemon keeps its own label.
    const claude = await handleHookEvent(
      { ...start, session_id: "claude-1", transcript_path: "/t.jsonl" },
      {},
      deps,
    );
    expect((claude.events[0]?.agent as { harness: string }).harness).toBe(
      "claude-code",
    );

    // The label survives daemon.json persistence.
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now,
    });
    restored.restore(registry.state());
    expect(restored.get("codex-1")?.harness).toBe("codex");
    const later = await handleHookEvent(
      {
        session_id: "codex-1",
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
      },
      {},
      { ...deps, registry: restored },
      undefined,
      "codex",
    );
    expect((later.events[0]?.agent as { harness: string }).harness).toBe(
      "codex",
    );
  });

  it("numbers each Stella invocation of one repeated call, and still pairs Pre with Post", async () => {
    const { deps, registry } = harness({
      permissions: { allow: ["Bash(ls*)"], deny: [], ask: [] },
    });
    const session = "stella-7-abcdef";
    const derived = stellaToolUseId("Bash", { command: "ls" });
    const call = {
      session_id: session,
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: derived,
    };
    await handleHookEvent(
      { session_id: session, hook_event_name: "SessionStart", cwd: "/repo" },
      {},
      deps,
      undefined,
      "stella",
    );
    const ids: Array<[string | undefined, string | undefined]> = [];
    for (let round = 0; round < 2; round += 1) {
      const pre = await handleHookEvent(
        { ...call, hook_event_name: "PreToolUse" },
        {},
        deps,
        undefined,
        "stella",
      );
      const post = await handleHookEvent(
        { ...call, hook_event_name: "PostToolUse", tool_response: "ok" },
        {},
        deps,
        undefined,
        "stella",
      );
      ids.push([toolUseIdOf(pre.events), toolUseIdOf(post.events)]);
    }
    // The pair still matches — that is what the derived digest buys — but the
    // two invocations no longer share an id, so the trace oracles stop
    // reading the second `ls` as a replay of the first.
    expect(ids[0]?.[0]).toBeDefined();
    expect(ids[0]?.[1]).toBe(ids[0]?.[0]);
    expect(ids[1]?.[1]).toBe(ids[1]?.[0]);
    expect(ids[1]?.[0]).not.toBe(ids[0]?.[0]);
    expect(ids[0]?.[0]?.startsWith(`${derived}_`)).toBe(true);
    // A closed pair leaves nothing open on the record.
    expect(registry.get(session)?.toolUseIds).toEqual({});

    // A harness that issues real tool-use ids keeps them byte for byte.
    const claude = await handleHookEvent(
      { ...call, session_id: "claude-9", hook_event_name: "PreToolUse" },
      {},
      deps,
    );
    expect(toolUseIdOf(claude.events)).toBe(derived);
  });

  it("keeps an operator message queued when Stella has nowhere to receive it", async () => {
    const { deps, registry, acks } = harness();
    const session = "stella-9-fedcba";
    const start = {
      session_id: session,
      hook_event_name: "SessionStart",
      cwd: "/repo",
    };
    await handleHookEvent(start, {}, deps, undefined, "stella");
    const record = registry.get(session);
    if (record === undefined) throw new Error("no record");
    record.control.messages.push({
      id: "cmd_1",
      text: "Wrap up and stop.",
      command: "message",
      requestedMode: null,
      deliveryMode: null,
      degradedReason: null,
      expiresAt: null,
    });
    // Stella answers UserPromptSubmit with a decision document, which has
    // nowhere to carry additionalContext: draining there would seal
    // `message_delivered` and drop the text on the floor.
    const prompt = await handleHookEvent(
      {
        session_id: session,
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
      },
      {},
      deps,
      undefined,
      "stella",
    );
    expect(prompt.response).toEqual({});
    expect(acks).toEqual([]);
    expect(record.control.messages).toHaveLength(1);
    expect(prompt.events.some((e) => e.kind === "oxagen:command_applied")).toBe(
      false,
    );
    // It lands at the next boundary Stella does read.
    const resumed = await handleHookEvent(start, {}, deps, undefined, "stella");
    expect(resumed.response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "You are governed by Oxagen.\n\nWrap up and stop.",
      },
    });
    expect(acks.map((ack) => ack.command_id)).toEqual(["cmd_1"]);
    expect(acks[0]?.status).toBe("applied");
    expect(record.control.messages).toHaveLength(0);
  });

  it("holds an operator message back from a blocked session start", async () => {
    const { deps, registry, acks } = harness({}, { hostStatus: "paused" });
    const start = loadFixtures()[0] as Fixture;
    await handleHookEvent(start.stdin, start.env, deps);
    const record = registry.get(String(start.stdin["session_id"]));
    if (record === undefined) throw new Error("no record");
    record.control.messages.push({
      id: "cmd_1",
      text: "Wrap up and stop.",
      command: "message",
      requestedMode: null,
      deliveryMode: null,
      degradedReason: null,
      expiresAt: null,
    });
    // A blocked start answers `continue: false` and carries no context.
    const blocked = await handleHookEvent(start.stdin, start.env, deps);
    expect(blocked.response).toMatchObject({ continue: false });
    expect(acks).toEqual([]);
    expect(record.control.messages).toHaveLength(1);
  });

  it("pairs each body with the event it belongs to, across the parent and its subagent", async () => {
    const { deps } = harness();
    const session = "sess-bodies";
    await handleHookEvent(
      { session_id: session, hook_event_name: "SessionStart", cwd: "/repo" },
      {},
      deps,
    );
    const prompt = await handleHookEvent(
      {
        session_id: session,
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
      },
      {},
      deps,
    );
    const turnStart = prompt.events.find((e) => e.kind === "turn_start");
    expect(prompt.bodies).toHaveLength(1);
    expect(prompt.bodies[0]).toMatchObject({
      event_id_idem: turnStart?.event_id_idem,
      session_uuid: turnStart?.session_uuid,
      content_class: "model_call",
    });
    expect(turnStart?.content?.digest).toBe(
      digestBytes(prompt.bodies[0]?.bytes as Uint8Array),
    );
    // A PreToolUse seals a collector policy_decision and the tool_requested
    // frame; only the frame with bytes has a body.
    const tool = await handleHookEvent(
      {
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_b1",
      },
      {},
      deps,
    );
    const requested = tool.events.find((e) => e.kind === "tool_requested");
    expect(tool.bodies.map((b) => b.event_id_idem)).toEqual([
      requested?.event_id_idem,
    ]);
    // A subagent's frames seal on the child chain, and their bodies are
    // drained through the parent with everything else.
    const sub = await handleHookEvent(
      {
        session_id: session,
        hook_event_name: "SubagentStop",
        agent_id: "agent-b1",
        agent_type: "Explore",
        last_assistant_message: "Found it.",
      },
      {},
      deps,
    );
    const childStop = sub.events.find(
      (e) => e.kind === "subagent_stop" && e.parent_session_uuid !== undefined,
    );
    expect(sub.bodies.map((b) => b.event_id_idem)).toEqual([
      childStop?.event_id_idem,
    ]);
    expect(sub.bodies[0]?.session_uuid).toBe(childStop?.session_uuid);
    // A frame with nothing to ship leaves the list empty.
    const end = await handleHookEvent(
      { session_id: session, hook_event_name: "SessionEnd", reason: "other" },
      {},
      deps,
    );
    expect(end.bodies).toEqual([]);
  });
});

describe("Cursor session working directories", () => {
  it("keeps the explicit active root across later inferred hooks", async () => {
    const { deps } = harness();
    const send = async (
      hook_event_name: string,
      extra: Record<string, unknown> = {},
    ) => {
      const payload = translateCursorPayload({
        conversation_id: "multi-root",
        hook_event_name,
        workspace_roots: ["/repo/first", "/repo/second"],
        ...extra,
      });
      const outcome = await handleHookEvent(
        payload,
        {},
        deps,
        undefined,
        "cursor",
      );
      const sourceEvents = outcome.events.filter(
        (event) => event.raw_source_digest !== undefined,
      );
      expect(sourceEvents.length).toBeGreaterThan(0);
      for (const event of sourceEvents) {
        expect(event.raw_source_digest).toBe(digestJcs(payload as JsonValue));
        expect(event.context?.cwd).toBe(outcome.record?.cwd);
      }
      return outcome;
    };
    expect((await send("sessionStart")).record?.cwd).toBe("/repo/first");
    expect(
      (
        await send("preToolUse", {
          cwd: "/repo/second",
          tool_name: "Read",
          tool_input: { path: "a.ts" },
          tool_use_id: "one",
        })
      ).record?.cwd,
    ).toBe("/repo/second");
    expect(
      (
        await send("postToolUse", {
          tool_name: "Read",
          tool_use_id: "one",
          tool_output: "body",
        })
      ).record?.cwd,
    ).toBe("/repo/second");
    expect(
      (
        await send("preToolUse", {
          tool_name: "Read",
          tool_input: { path: "inferred.ts" },
          tool_use_id: "inferred",
        })
      ).record?.cwd,
    ).toBe("/repo/second");
    expect(
      (
        await send("subagentStart", {
          agent_id: "child",
          agent_type: "Explore",
        })
      ).record?.cwd,
    ).toBe("/repo/second");
    expect((await send("stop")).record?.cwd).toBe("/repo/second");
    expect(
      (
        await send("preToolUse", {
          cwd: "/repo/first",
          tool_name: "Read",
          tool_input: { path: "b.ts" },
          tool_use_id: "two",
        })
      ).record?.cwd,
    ).toBe("/repo/first");
  });
});
