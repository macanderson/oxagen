/**
 * Pause, resume, steer and stop reaching an agent that works on its own
 * (#4019). Before this, a steer waited for the next prompt a person typed,
 * a resumed agent stayed idle, and a subagent's tool decision was sealed on
 * the parent's chain while its tool request sat on the subagent's.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type {
  CommandAcknowledgement,
  DeliveredCommand,
  PolicyBundle,
} from "../wire";
import { handleHookEvent, type PolicyView, RESUMED_TEXT } from "./hook-handler";
import { applyCommands } from "./inbox";
import { type RegistryState, SessionRegistry } from "./registry";

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

const SESSION = "340ed354-6344-4727-9f8b-1e40b5e12aa7";

function harness(bundleOverrides: Partial<Omit<PolicyBundle, "signature">> = {}) {
  const bundle = bundleSigner().sign(unsignedBundle(bundleOverrides));
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
  };
  const acks: CommandAcknowledgement[] = [];
  const deps = {
    registry,
    policy: () => view,
    acknowledge: (ack: CommandAcknowledgement) => acks.push(ack),
    now,
  };
  return { registry, deps, acks, now };
}

type Harness = ReturnType<typeof harness>;

function hook(
  hook_event_name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: SESSION,
    cwd: "/home/dev/proj",
    hook_event_name,
    ...extra,
  };
}

const READ = {
  tool_name: "Read",
  tool_input: { file_path: "/home/dev/proj/README.md" },
  tool_use_id: "toolu_read",
};

async function started(h: Harness, agentHarness?: "stella") {
  await handleHookEvent(
    hook("SessionStart", { source: "startup" }),
    {},
    h.deps,
    undefined,
    agentHarness,
  );
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return record;
}

function steer(
  id: string,
  text: string,
  deliveryMode: "next_step" | "interrupt" = "next_step",
) {
  return {
    id,
    text,
    command: "steer" as const,
    requestedMode: deliveryMode,
    deliveryMode,
    degradedReason: null,
    expiresAt: null,
  };
}

function command(overrides: Partial<DeliveredCommand>): DeliveredCommand {
  return {
    id: "cmd",
    command: "pause",
    session_uuid: null,
    payload: {},
    requested_mode: null,
    delivery_mode: null,
    degraded_reason: null,
    reason: null,
    issued_at: "2026-09-10T10:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

async function control(
  h: Harness,
  record: Awaited<ReturnType<typeof started>>,
  overrides: Partial<DeliveredCommand>,
) {
  return applyCommands(
    [command({ session_uuid: record.recorder.sessionUuid, ...overrides })],
    {
      registry: h.registry,
      hostRecorder: () => record.recorder,
      kill: () => true,
      refreshBundle: async () => undefined,
      onHostSuspended: () => undefined,
      now: h.now,
    },
  );
}

describe("steer delivery to an agent working on its own", () => {
  it("delivers a queued steer once, at the next PostToolUse", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(steer("cmd_s", "Use the staging database."));
    const first = await handleHookEvent(
      hook("PostToolUse", { ...READ, tool_response: "ok" }),
      {},
      h.deps,
    );
    expect(first.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Use the staging database.",
      },
    });
    const frame = first.events.find(
      (e) => e.kind === "oxagen:command_applied",
    );
    expect(frame?.attrs?.["command.id"]).toBe("cmd_s");
    expect(h.acks).toEqual([
      expect.objectContaining({
        command_id: "cmd_s",
        status: "applied",
        applied_at_seq: frame?.seq,
      }),
    ]);
    const second = await handleHookEvent(
      hook("PostToolUseFailure", { ...READ, error: "boom" }),
      {},
      h.deps,
    );
    expect(second.response).toEqual({});
    expect(h.acks).toHaveLength(1);
  });

  it("keeps the turn going at Stop with the steer as the reason", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(steer("cmd_s", "Also update the changelog."));
    const stop = await handleHookEvent(hook("Stop"), {}, h.deps);
    expect(stop.response).toEqual({
      decision: "block",
      reason: "Also update the changelog.",
    });
    expect(h.acks.map((a) => a.command_id)).toEqual(["cmd_s"]);
    const again = await handleHookEvent(
      hook("Stop", { stop_hook_active: true }),
      {},
      h.deps,
    );
    expect(again.response).toEqual({});
  });

  it("holds a steer back from a subagent's boundary and from a replay", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(steer("cmd_s", "Stop exploring."));
    const sub = await handleHookEvent(
      hook("PostToolUse", {
        ...READ,
        agent_id: "agent-1",
        agent_type: "Explore",
        tool_response: "ok",
      }),
      {},
      h.deps,
    );
    expect(sub.response).toEqual({});
    const replayed = await handleHookEvent(
      hook("Stop"),
      {},
      h.deps,
      { receivedAt: "2026-09-10T09:59:00.000Z" },
    );
    expect(replayed.response).toEqual({});
    expect(record.control.messages).toHaveLength(1);
    expect(h.acks).toEqual([]);
  });

  it("keeps a steer queued at a Stella Stop, which cannot carry it", async () => {
    const h = harness();
    const record = await started(h, "stella");
    record.control.messages.push(steer("cmd_s", "Stop exploring."));
    const stop = await handleHookEvent(
      hook("Stop"),
      {},
      h.deps,
      undefined,
      "stella",
    );
    expect(stop.response).toEqual({});
    expect(record.control.messages).toHaveLength(1);
  });

  it("delivers an interrupt steer as the reason the next tool call is refused", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(
      steer("cmd_i", "Stop and read the brief first.", "interrupt"),
    );
    const call = await handleHookEvent(hook("PreToolUse", READ), {}, h.deps);
    expect(call.evaluation).toMatchObject({
      decision: "deny",
      source: "human",
      reason_code: "steer_interrupt",
    });
    expect(call.response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "Stop and read the brief first.",
        ),
      },
    });
    expect(call.events.some((e) => e.kind === "token_denied")).toBe(true);
    expect(h.acks.map((a) => [a.command_id, a.status])).toEqual([
      ["cmd_i", "applied"],
    ]);
    // A next-step steer does not refuse a call.
    record.control.messages.push(steer("cmd_n", "Later."));
    const next = await handleHookEvent(hook("PreToolUse", READ), {}, h.deps);
    expect(next.evaluation?.reason_code).not.toBe("steer_interrupt");
    expect(record.control.messages).toHaveLength(1);
  });
});

describe("resume", () => {
  it("tells an agent the pause refused to continue, at its Stop", async () => {
    const h = harness();
    const record = await started(h);
    await control(h, record, { id: "cmd_p", command: "pause" });
    const refused = await handleHookEvent(hook("PreToolUse", READ), {}, h.deps);
    expect(refused.evaluation?.reason_code).toBe("session_paused");
    expect(record.control.pauseEffect).toBe("refused");
    const resumed = await control(h, record, { id: "cmd_r", command: "resume" });
    expect(resumed.acknowledgements[0]).toMatchObject({
      command_id: "cmd_r",
      status: "applied",
    });
    expect(resumed.acknowledgements[0]?.detail).toBeUndefined();
    expect(record.control.resumeOwed).toBe("cmd_r");
    const stop = await handleHookEvent(hook("Stop"), {}, h.deps);
    expect(stop.response).toEqual({ decision: "block", reason: RESUMED_TEXT });
    const frame = stop.events.find((e) => e.kind === "oxagen:command_applied");
    expect(frame?.attrs).toMatchObject({
      "command.id": "cmd_r",
      "command.name": "resume",
    });
    // The resume was acknowledged when it applied; delivery sends no second.
    expect(h.acks).toEqual([]);
    expect(record.control.resumeOwed).toBeUndefined();
    const again = await handleHookEvent(hook("Stop"), {}, h.deps);
    expect(again.response).toEqual({});
  });

  it("lets a paused agent end its turn and reports it idle on resume", async () => {
    const h = harness();
    const record = await started(h);
    await control(h, record, { id: "cmd_p", command: "pause" });
    await handleHookEvent(hook("PreToolUse", READ), {}, h.deps);
    const stop = await handleHookEvent(hook("Stop"), {}, h.deps);
    expect(stop.response).toEqual({});
    expect(record.control.pauseEffect).toBe("stopped");
    const resumed = await control(h, record, { id: "cmd_r", command: "resume" });
    expect(resumed.acknowledgements[0]?.detail).toMatch(/idle/);
    expect(record.control.resumeOwed).toBeUndefined();
  });

  it("owes nothing when a person prompts first", async () => {
    const h = harness();
    const record = await started(h);
    await control(h, record, { id: "cmd_p", command: "pause" });
    await handleHookEvent(hook("PreToolUse", READ), {}, h.deps);
    await control(h, record, { id: "cmd_r", command: "resume" });
    await handleHookEvent(
      hook("UserPromptSubmit", { prompt: "carry on" }),
      {},
      h.deps,
    );
    expect(record.control.resumeOwed).toBeUndefined();
  });

  it("survives a daemon restart", async () => {
    const h = harness();
    const record = await started(h);
    record.control.pauseEffect = "refused";
    record.control.resumeOwed = "cmd_r";
    const state = JSON.parse(JSON.stringify(h.registry.state())) as RegistryState;
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: h.now,
    });
    restored.restore(state);
    expect(restored.get(SESSION)?.control).toMatchObject({
      pauseEffect: "refused",
      resumeOwed: "cmd_r",
    });
  });
});

describe("pause and cancel in observe mode", () => {
  it("refuses tool calls whatever the mandate's mode", async () => {
    const h = harness({ mode: "observe" });
    const record = await started(h);
    record.control.paused = "review pending";
    const paused = await handleHookEvent(hook("PreToolUse", READ), {}, h.deps);
    expect(paused.evaluation?.decision).toBe("deny");
    expect(paused.evaluation?.reason_code).toBe("session_paused");
    record.control.paused = null;
    record.control.cancelled = "done";
    const cancelled = await handleHookEvent(
      hook("PreToolUse", READ),
      {},
      h.deps,
    );
    expect(cancelled.evaluation?.decision).toBe("deny");
    expect(cancelled.evaluation?.reason_code).toBe("session_cancelled");
  });
});

describe("a subagent's tool decision", () => {
  it("is sealed on the subagent chain beside its tool request", async () => {
    const h = harness();
    const record = await started(h);
    const call = await handleHookEvent(
      hook("PreToolUse", {
        ...READ,
        agent_id: "agent-1",
        agent_type: "Explore",
      }),
      {},
      h.deps,
    );
    const decision = call.events.find((e) => e.kind === "policy_decision");
    const request = call.events.find((e) => e.kind === "tool_requested");
    expect(decision).toBeDefined();
    expect(decision?.session_uuid).toBe(request?.session_uuid);
    expect(decision?.session_uuid).not.toBe(record.recorder.sessionUuid);
    expect(decision?.parent_session_uuid).toBe(record.recorder.sessionUuid);
  });
});
