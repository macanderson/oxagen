/**
 * A live prompt asks the control plane for the memories most relevant to it
 * and hands them to the agent after the operator's messages, within what the
 * answer has left (#4458). A blocked or replayed prompt asks nothing, and
 * neither does a prompt of Stella or Cursor, whose prompt answers carry no
 * text to the agent.
 */
import { describe, expect, it } from "vitest";
import { type ClaudeCodeContext, digestText } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import {
  ADDITIONAL_CONTEXT_MAX_CHARS,
  handleHookEvent,
  type HookHandlerDeps,
  type PolicyView,
  RECALL_HEADING,
} from "./hook-handler";
import type {
  MemoryRecallRequest,
  RecalledMemory,
} from "./memory-capture/memory-recall";
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

const SESSION = "sess-recall";

const MEMORIES: RecalledMemory[] = [
  { id: "a-intel.memory.pnpm", statement: "Use pnpm,\n  never npm." },
  { id: "mem_01", statement: "Run the gate in CI." },
];

function harness(memories: readonly RecalledMemory[] = MEMORIES) {
  const bundle = bundleSigner().sign(unsignedBundle({ context: { system: null } }));
  let clock = Date.parse("2026-09-27T01:00:00.000Z");
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
  const asked: MemoryRecallRequest[] = [];
  const deps: HookHandlerDeps = {
    registry,
    policy: () => view,
    acknowledge: () => undefined,
    now,
    recallMemories: async (request) => {
      asked.push(request);
      return memories;
    },
  };
  return { registry, deps, asked, view };
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
  prompt: "How do I install?",
};

function contextOf(response: Record<string, unknown>): string | undefined {
  const specific = response["hookSpecificOutput"] as
    | { additionalContext?: string }
    | undefined;
  return specific?.additionalContext;
}

async function opened(h: ReturnType<typeof harness>, name?: TachoHarness) {
  await handleHookEvent(start, {}, h.deps, undefined, name);
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return record;
}

const EXPECTED = `${RECALL_HEADING}\n- Use pnpm, never npm.\n- Run the gate in CI.`;

describe("memory recall at a prompt", () => {
  it("hands a live prompt its recalled memories, one line each", async () => {
    const h = harness();
    await opened(h);
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(h.asked).toEqual([{ repository: null, text: "How do I install?" }]);
    expect(outcome.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: EXPECTED,
      },
    });
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.recall_digest"]).toBe(digestText(EXPECTED));
    expect(turn?.attrs["oxagen.recalled_memories"]).toBe("2");
  });

  it("adds nothing when the control plane recalls nothing", async () => {
    const h = harness([]);
    await opened(h);
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(h.asked).toHaveLength(1);
    expect(outcome.response).toEqual({});
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.recall_digest"]).toBeUndefined();
    expect(turn?.attrs["oxagen.recalled_memories"]).toBeUndefined();
  });

  it("asks nothing for a prompt the operator blocked", async () => {
    const h = harness();
    await opened(h);
    h.view.hostStatus = "paused";
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(outcome.response).toMatchObject({ decision: "block" });
    expect(h.asked).toEqual([]);
  });

  it("asks nothing for a replayed prompt, which the harness already sent on", async () => {
    const h = harness();
    await opened(h);
    await handleHookEvent(prompt, {}, h.deps, {
      receivedAt: "2026-09-27T01:00:05.000Z",
    });
    expect(h.asked).toEqual([]);
  });

  it.each(["stella", "cursor"] as const)(
    "asks nothing for a %s prompt, whose answer carries no text to the agent",
    async (name) => {
      const h = harness();
      await opened(h, name);
      const outcome = await handleHookEvent(prompt, {}, h.deps, undefined, name);
      expect(h.asked).toEqual([]);
      expect(contextOf(outcome.response)).toBeUndefined();
    },
  );

  it("asks for a Codex prompt, whose answer the agent reads", async () => {
    const h = harness();
    await opened(h, "codex");
    const outcome = await handleHookEvent(prompt, {}, h.deps, undefined, "codex");
    expect(h.asked).toHaveLength(1);
    expect(contextOf(outcome.response)).toBe(EXPECTED);
  });

  it("puts the memories after the operator's messages", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(message("cmd_1", "Stop and read the brief."));
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(outcome.response)).toBe(
      `Stop and read the brief.\n\n${EXPECTED}`,
    );
  });

  it("leaves out a memory that does not fit beside the messages, and keeps a shorter one after it", async () => {
    const long = "l".repeat(400);
    const h = harness([
      { id: "long", statement: long },
      { id: "short", statement: "Use pnpm." },
    ]);
    const record = await opened(h);
    // The message leaves room for the heading and the short memory only.
    const filler = "f".repeat(
      ADDITIONAL_CONTEXT_MAX_CHARS -
        "\n\n".length -
        RECALL_HEADING.length -
        "\n- Use pnpm.".length,
    );
    record.control.messages.push(message("cmd_fill", filler));
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    const text = contextOf(outcome.response);
    expect(text).toBe(`${filler}\n\n${RECALL_HEADING}\n- Use pnpm.`);
    expect(text?.length).toBe(ADDITIONAL_CONTEXT_MAX_CHARS);
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.recalled_memories"]).toBe("1");
  });

  it("adds nothing when no memory fits beside the messages", async () => {
    const h = harness();
    const record = await opened(h);
    const filler = "f".repeat(ADDITIONAL_CONTEXT_MAX_CHARS - 10);
    record.control.messages.push(message("cmd_fill", filler));
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(outcome.response)).toBe(filler);
  });
});
