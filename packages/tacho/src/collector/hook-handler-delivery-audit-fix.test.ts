/**
 * A queued operator message is sealed `command_applied` and acknowledged
 * `applied` only when the agent reads it whole. Claude Code keeps 10,000
 * characters of a hook's `additionalContext`, so one answer carries at most
 * 9,500, prefix included, and what does not fit waits for the next boundary.
 * A spool replay answers nobody, and neither does a hook the daemon deferred
 * after answering it, so neither drains anything.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { CommandAcknowledgement } from "../wire";
import {
  ADDITIONAL_CONTEXT_MAX_CHARS,
  handleHookEvent,
  type HookReplay,
  type PolicyView,
  RESUMED_TEXT,
} from "./hook-handler";
import { type QueuedPrompt, SessionRegistry } from "./registry";

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

const SESSION = "sess-delivery";

function harness(system: string | null = "You are governed by Oxagen.") {
  const bundle = bundleSigner().sign(unsignedBundle({ context: { system } }));
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

function message(id: string, text: string): QueuedPrompt {
  return {
    id,
    text,
    command: "steer",
    requestedMode: "next_step",
    deliveryMode: "next_step",
    degradedReason: null,
    expiresAt: null,
  };
}

const start = { session_id: SESSION, hook_event_name: "SessionStart" };
const prompt = {
  session_id: SESSION,
  hook_event_name: "UserPromptSubmit",
  prompt: "go on",
};

async function opened(h: ReturnType<typeof harness>) {
  await handleHookEvent(start, {}, h.deps);
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return record;
}

function contextOf(response: Record<string, unknown>): string | undefined {
  const specific = response["hookSpecificOutput"] as
    | { additionalContext?: string }
    | undefined;
  return specific?.additionalContext;
}

describe("the additionalContext budget", () => {
  it("delivers at a session start only what fits beside the prefix, and the rest at the next prompt", async () => {
    const prefix = "p".repeat(8_000);
    const h = harness(prefix);
    const record = await opened(h);
    record.control.messages.push(
      message("cmd_short", "s".repeat(1_000)),
      message("cmd_long", "l".repeat(2_000)),
      message("cmd_after", "a".repeat(10)),
    );
    const again = await handleHookEvent(start, {}, h.deps);
    const text = contextOf(again.response)!;
    expect(text).toBe(`${prefix}\n\n${"s".repeat(1_000)}`);
    expect(text.length).toBeLessThanOrEqual(ADDITIONAL_CONTEXT_MAX_CHARS);
    // The start event records how much it handed over.
    const startEvent = again.events.find(
      (e) => e.attrs?.["oxagen.context_digest"] !== undefined,
    );
    expect(startEvent?.attrs?.["oxagen.delivered_chars"]).toBe(
      String(text.length),
    );
    // Only the delivered one is sealed and acknowledged.
    const applied = again.events.filter(
      (e) => e.kind === "oxagen:command_applied",
    );
    expect(applied.map((e) => e.attrs?.["command.id"])).toEqual(["cmd_short"]);
    expect(h.acks.map((a) => `${a.command_id}:${a.status}`)).toEqual([
      "cmd_short:applied",
    ]);
    // The rest wait in order.
    expect(record.control.messages.map((m) => m.id)).toEqual([
      "cmd_long",
      "cmd_after",
    ]);
    const next = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(next.response)).toBe(
      `${"l".repeat(2_000)}\n\n${"a".repeat(10)}`,
    );
    expect(record.control.messages).toEqual([]);
    expect(h.acks.map((a) => `${a.command_id}:${a.status}`)).toEqual([
      "cmd_short:applied",
      "cmd_long:applied",
      "cmd_after:applied",
    ]);
    expect(
      verifyChain(record.recorder.sealedEvents, { expectGenesis: true })
        .violations,
    ).toEqual([]);
  });

  it("records the prefix length when no message rides with it", async () => {
    const h = harness();
    const first = await handleHookEvent(start, {}, h.deps);
    const startEvent = first.events.find(
      (e) => e.attrs?.["oxagen.context_digest"] !== undefined,
    );
    expect(startEvent?.attrs?.["oxagen.delivered_chars"]).toBe(
      String("You are governed by Oxagen.".length),
    );
  });

  it("splits a prompt's messages across prompts rather than overflow one answer", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(
      message("cmd_1", "1".repeat(8_000)),
      message("cmd_2", "2".repeat(8_000)),
    );
    const first = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(first.response)).toBe("1".repeat(8_000));
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_2"]);
    const second = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(second.response)).toBe("2".repeat(8_000));
    expect(h.acks.map((a) => `${a.command_id}:${a.status}`)).toEqual([
      "cmd_1:applied",
      "cmd_2:applied",
    ]);
  });

  it("keeps a mid-turn answer under the cap with room for a resume's continuation", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.resumeOwed = "cmd_resume";
    record.control.messages.push(
      message("cmd_fill", "f".repeat(ADDITIONAL_CONTEXT_MAX_CHARS - 10)),
    );
    const tool = {
      session_id: SESSION,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/README.md" },
      tool_use_id: "toolu_read",
    };
    const first = await handleHookEvent(tool, {}, h.deps);
    // The steer would push the answer past the cap beside the continuation,
    // so the continuation goes now and the steer at the next boundary.
    expect(contextOf(first.response)).toBe(RESUMED_TEXT);
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_fill"]);
    const second = await handleHookEvent(
      { ...tool, tool_use_id: "toolu_read_2" },
      {},
      h.deps,
    );
    expect(contextOf(second.response)).toBe(
      "f".repeat(ADDITIONAL_CONTEXT_MAX_CHARS - 10),
    );
    expect(h.acks.map((a) => `${a.command_id}:${a.status}`)).toEqual([
      "cmd_fill:applied",
    ]);
  });

  it("counts an interrupt's lead against the cap, its space included", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.resumeOwed = "cmd_resume";
    const lead = "Your Oxagen operator interrupted this step. ";
    // One character more than fits beside the lead and the continuation.
    const text = "i".repeat(
      ADDITIONAL_CONTEXT_MAX_CHARS - lead.length - RESUMED_TEXT.length - 1,
    );
    record.control.messages.push({
      ...message("cmd_interrupt", text),
      requestedMode: "interrupt",
      deliveryMode: "interrupt",
    });
    const call = await handleHookEvent(
      {
        session_id: SESSION,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_read",
      },
      {},
      h.deps,
    );
    expect(call.evaluation?.reason).toBe(`${lead}${RESUMED_TEXT}`);
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_interrupt"]);
    expect(h.acks).toEqual([]);
  });

  it("fails a message no hook answer could carry, rather than let it hold up the queue", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(
      message("cmd_huge", "h".repeat(ADDITIONAL_CONTEXT_MAX_CHARS + 1)),
      message("cmd_next", "Use the staging database."),
    );
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(outcome.response)).toBe("Use the staging database.");
    expect(h.acks[0]).toMatchObject({
      command_id: "cmd_huge",
      status: "failed",
    });
    expect(h.acks[0]?.detail?.length).toBeLessThanOrEqual(512);
    expect(h.acks[1]).toMatchObject({
      command_id: "cmd_next",
      status: "applied",
    });
    expect(record.control.messages).toEqual([]);
  });
});

describe("a replayed hook", () => {
  const spooled: HookReplay = { receivedAt: "2026-09-10T10:00:30.000Z" };

  it("drains nothing at a replayed prompt: no frame, no acknowledgement, still queued", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(message("cmd_1", "Wrap up and stop."));
    const replayed = await handleHookEvent(prompt, {}, h.deps, spooled);
    expect(
      replayed.events.some((e) => e.kind === "oxagen:command_applied"),
    ).toBe(false);
    expect(h.acks).toEqual([]);
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_1"]);
    // The next live prompt delivers it.
    const live = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(live.response)).toBe("Wrap up and stop.");
    expect(h.acks.map((a) => `${a.command_id}:${a.status}`)).toEqual([
      "cmd_1:applied",
    ]);
  });

  it("drains nothing at a replayed session start, and records only the prefix", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(message("cmd_1", "Wrap up and stop."));
    const replayed = await handleHookEvent(start, {}, h.deps, spooled);
    expect(
      replayed.events.some((e) => e.kind === "oxagen:command_applied"),
    ).toBe(false);
    expect(h.acks).toEqual([]);
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_1"]);
    const startEvent = replayed.events.find(
      (e) => e.attrs?.["oxagen.context_digest"] !== undefined,
    );
    expect(startEvent?.attrs?.["hook.replayed"]).toBe("1");
    expect(startEvent?.attrs?.["oxagen.delivered_chars"]).toBe(
      String("You are governed by Oxagen.".length),
    );
  });

  it("drains nothing at a hook the daemon deferred, whose answer already went out", async () => {
    // The daemon defers a hook (a SessionEnd waiting for its git read) after
    // it has answered the harness, so nobody reads this answer either.
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(message("cmd_1", "Wrap up and stop."));
    const deferred = await handleHookEvent(prompt, {}, h.deps, {
      ...spooled,
      deferred: true,
    });
    expect(contextOf(deferred.response)).toBeUndefined();
    expect(h.acks).toEqual([]);
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_1"]);
  });
});
