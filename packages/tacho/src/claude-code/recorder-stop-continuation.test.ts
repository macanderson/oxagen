/**
 * A turn that goes on past the hook that seemed to end it.
 *
 * The daemon seals a `Stop` before it decides its answer. When it answers
 * `decision: "block"` (a queued steer, a resume's continuation, the
 * reflection ask), Claude Code keeps working in the same turn under the same
 * `prompt_id`. Claude Code also starts the session again after every
 * compaction, on the same session id and often mid-turn. In both cases the
 * chain must keep the work that follows inside the turn, and the trace must
 * not lose it.
 */
import { describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import { runOracles } from "../trace/oracles";
import { projectToTrace } from "../trace/project";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";

const ID = "11111111-2222-3333-4444-888888888888";
const SCOPE = "host-stop-continuation-test";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

/** One second past 10:00 for each step, so the order of hooks is plain. */
const at = (second: number): string =>
  `2026-10-03T10:00:${String(second).padStart(2, "0")}.000Z`;

function started(): SessionRecorder {
  const chain = new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: SCOPE,
  });
  chain.ingestHook(
    { session_id: ID, hook_event_name: "SessionStart" },
    {},
    at(0),
  );
  return chain;
}

function hook(
  chain: SessionRecorder,
  second: number,
  payload: Record<string, unknown>,
): TachoEvent[] {
  return chain.ingestHook({ session_id: ID, ...payload }, {}, at(second));
}

const pre = (promptId: string, toolUseId: string) => ({
  hook_event_name: "PreToolUse",
  prompt_id: promptId,
  tool_name: "Bash",
  tool_input: { command: "ls" },
  tool_use_id: toolUseId,
});

const post = (promptId: string, toolUseId: string) => ({
  ...pre(promptId, toolUseId),
  hook_event_name: "PostToolUse",
  tool_response: "README.md\n",
});

/** A chain whose first turn, on prompt p1, a `Stop` closed at second 2. */
function stoppedOnce(): SessionRecorder {
  const chain = started();
  hook(chain, 1, {
    hook_event_name: "UserPromptSubmit",
    prompt: "go",
    prompt_id: "p1",
  });
  const [end] = hook(chain, 2, {
    hook_event_name: "Stop",
    prompt_id: "p1",
    stop_hook_active: false,
  });
  expect(end?.kind).toBe("turn_end");
  expect(end?.turn?.turn_seq).toBe(1);
  expect(chain.turnIsOpen).toBe(false);
  return chain;
}

describe("a Stop the daemon answered with decision block", () => {
  it("opens the turn again for the work it sent the agent on to", () => {
    const chain = stoppedOnce();
    const [requested] = hook(chain, 3, pre("p1", "toolu_1"));
    expect(requested?.kind).toBe("tool_requested");
    expect(requested?.turn?.turn_seq).toBe(1);
    expect(chain.turnIsOpen).toBe(true);
    const result = hook(chain, 4, post("p1", "toolu_1"));
    expect(result.map((event) => event.turn?.turn_seq)).toEqual([1, 1]);
    const [end] = hook(chain, 5, {
      hook_event_name: "Stop",
      prompt_id: "p1",
      stop_hook_active: true,
    });
    expect(end?.kind).toBe("turn_end");
    expect(end?.turn?.turn_seq).toBe(1);
    expect(chain.turnIsOpen).toBe(false);
    expect(chain.turnCount).toBe(1);

    // The trace keeps the call inside the turn, which ends once.
    const journal = projectToTrace(chain.sealedEvents);
    const kinds = journal.events.map((event) => event.event);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds.filter((kind) => kind === "turn_end")).toHaveLength(1);
    expect(
      runOracles(journal).checks.filter((check) => check.status === "fail"),
    ).toEqual([]);
  });

  it("opens the turn on a second Stop that says a stop hook sent the agent on", () => {
    const chain = stoppedOnce();
    // The agent only answered in text, so no tool hook came between.
    const [end] = hook(chain, 3, {
      hook_event_name: "Stop",
      prompt_id: "p1",
      stop_hook_active: true,
    });
    expect(end?.kind).toBe("turn_end");
    expect(end?.turn?.turn_seq).toBe(1);
    expect(chain.turnIsOpen).toBe(false);
  });

  it("leaves the turn closed for a spool replay of a hook from before the Stop", () => {
    const chain = stoppedOnce();
    // A replay carries the time the hook first arrived.
    const [result] = hook(chain, 1, post("p1", "toolu_1"));
    expect(result?.kind).toBe("tool_call");
    expect(result?.turn?.turn_seq).toBeUndefined();
    expect(chain.turnIsOpen).toBe(false);
  });

  it("leaves the turn closed for a message, a notification, or another prompt's call", () => {
    const chain = stoppedOnce();
    hook(chain, 3, {
      hook_event_name: "MessageDisplay",
      prompt_id: "p1",
      delta: "Done.",
      final: true,
    });
    hook(chain, 3, {
      hook_event_name: "Notification",
      prompt_id: "p1",
      notification_type: "idle_prompt",
    });
    hook(chain, 4, pre("p2", "toolu_2"));
    expect(chain.turnIsOpen).toBe(false);
  });

  it("leaves a turn the person interrupted closed", () => {
    const chain = stoppedOnce();
    hook(chain, 3, pre("p1", "toolu_1"));
    expect(chain.turnIsOpen).toBe(true);
    chain.ingestTranscriptLine(
      JSON.stringify({
        type: "user",
        timestamp: at(4),
        promptId: "p1",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      }),
    );
    expect(chain.turnIsOpen).toBe(false);
    hook(chain, 5, post("p1", "toolu_1"));
    expect(chain.turnIsOpen).toBe(false);
  });

  it("carries the stopped turn over a restart and a rollback", () => {
    const restarted = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: stoppedOnce().state(),
    });
    hook(restarted, 3, pre("p1", "toolu_1"));
    expect(restarted.turnIsOpen).toBe(true);

    const rolled = stoppedOnce();
    const mark = rolled.markChain();
    // A new prompt forgets the stopped turn; the rollback brings it back.
    hook(rolled, 3, {
      hook_event_name: "UserPromptSubmit",
      prompt: "next",
      prompt_id: "p2",
    });
    rolled.rollbackChain(mark);
    expect(rolled.turnIsOpen).toBe(false);
    const [requested] = hook(rolled, 4, pre("p1", "toolu_1"));
    expect(requested?.turn?.turn_seq).toBe(1);
  });
});

describe("a compaction's SessionStart", () => {
  it("is no resume, and the turn it happened in goes on", () => {
    const chain = started();
    hook(chain, 1, {
      hook_event_name: "UserPromptSubmit",
      prompt: "go",
      prompt_id: "p1",
    });
    const [compacted] = hook(chain, 2, {
      hook_event_name: "SessionStart",
      source: "compact",
    });
    expect(compacted?.kind).toBe("agent_start");
    expect(compacted?.body).toMatchObject({ session_start_source: "compact" });
    expect(compacted?.body).not.toHaveProperty("resume_of_session_id");
    expect(compacted?.body).not.toHaveProperty("resume_last_seq_seen");
    expect(chain.turnIsOpen).toBe(true);
    hook(chain, 3, pre("p1", "toolu_1"));
    hook(chain, 4, post("p1", "toolu_1"));
    hook(chain, 5, { hook_event_name: "Stop", prompt_id: "p1" });

    const journal = projectToTrace(chain.sealedEvents);
    const kinds = journal.events.map((event) => event.event);
    expect(kinds).not.toContain("resume");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(
      runOracles(journal).checks.filter((check) => check.status === "fail"),
    ).toEqual([]);
  });

  it("still marks a resume as one", () => {
    const chain = started();
    const [resumed] = hook(chain, 1, {
      hook_event_name: "SessionStart",
      source: "resume",
    });
    expect(resumed?.body).toMatchObject({
      session_start_source: "resume",
      resume_of_session_id: ID,
      resume_last_seq_seen: 0,
    });
  });
});
