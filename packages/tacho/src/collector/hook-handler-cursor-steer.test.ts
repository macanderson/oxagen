/**
 * Where an operator's steer reaches a Cursor agent (ADR-141, #3367).
 *
 * Cursor's `beforeSubmitPrompt` answer carries only a `user_message` the
 * person reads, and its `postToolUse` answer has no field the daemon fills,
 * so a steer drained there would be sealed `message_delivered` while the
 * agent never saw it. The steer waits for `stop`, whose `followup_message`
 * Cursor submits as the next message in the conversation, or for
 * `preToolUse` when the operator asked to interrupt. Each payload here starts
 * in Cursor's own shape and goes through the adapter both ways, as it does
 * on a real machine.
 */
import { describe, expect, it } from "vitest";
import {
  cursorAnswer,
  translateCursorPayload,
} from "../claude-code/cursor-adapter";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { CommandAcknowledgement } from "../wire";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { SessionRegistry } from "./registry";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "cursor",
    harness: "cursor",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const CONVERSATION = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function harness() {
  const bundle = bundleSigner().sign(unsignedBundle());
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
  return { registry, deps, acks };
}

type Harness = ReturnType<typeof harness>;

/** A Cursor hook payload, as Cursor writes it to the hook's stdin. */
function cursorHook(
  event: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conversation_id: CONVERSATION,
    generation_id: "gen-1",
    hook_event_name: event,
    cursor_version: "3.22.7",
    workspace_roots: ["/home/dev/proj"],
    ...extra,
  };
}

const SHELL = {
  tool_name: "Shell",
  tool_input: { command: "ls" },
  tool_use_id: "tool_1",
  cwd: "/home/dev/proj",
};

/** Run one Cursor hook through the adapter and the daemon; return Cursor's stdout. */
async function run(h: Harness, event: string, extra = {}) {
  const translated = translateCursorPayload(cursorHook(event, extra)) as {
    hook_event_name: string;
  };
  const result = await handleHookEvent(
    translated,
    {},
    h.deps,
    undefined,
    "cursor",
  );
  return {
    result,
    stdout: JSON.parse(
      cursorAnswer(result.response, translated.hook_event_name),
    ) as Record<string, unknown>,
  };
}

async function started(h: Harness) {
  await run(h, "sessionStart", { session_id: CONVERSATION });
  const record = h.registry.get(CONVERSATION);
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

describe("a steer queued for a Cursor session", () => {
  it("stays queued at beforeSubmitPrompt and postToolUse, which cannot carry it to the agent", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(steer("cmd_s", "Use the staging database."));

    const prompt = await run(h, "beforeSubmitPrompt", { prompt: "go on" });
    expect(prompt.stdout).toEqual({ continue: true });
    const post = await run(h, "postToolUse", {
      ...SHELL,
      tool_output: "README.md",
    });
    expect(post.stdout).toEqual({});

    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_s"]);
    expect(h.acks).toEqual([]);
  });

  it("drains at stop as a follow-up message Cursor sends the agent, once", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(steer("cmd_s", "Also update the changelog."));

    const stop = await run(h, "stop", { status: "completed", loop_count: 0 });
    expect(stop.stdout).toEqual({
      followup_message: "Also update the changelog.",
    });
    const frame = stop.result.events.find(
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
    expect(record.control.messages).toEqual([]);

    const again = await run(h, "stop", { status: "completed", loop_count: 1 });
    expect(again.stdout).toEqual({});
    expect(h.acks).toHaveLength(1);
  });

  it("drains an interrupt at preToolUse as the reason the call is refused", async () => {
    const h = harness();
    const record = await started(h);
    record.control.messages.push(
      steer("cmd_i", "Stop and read the brief first.", "interrupt"),
    );

    const call = await run(h, "preToolUse", SHELL);
    expect(call.stdout).toMatchObject({
      permission: "deny",
      agent_message: expect.stringContaining("Stop and read the brief first."),
    });
    expect(h.acks.map((a) => [a.command_id, a.status])).toEqual([
      ["cmd_i", "applied"],
    ]);
    expect(record.control.messages).toEqual([]);
  });
});
