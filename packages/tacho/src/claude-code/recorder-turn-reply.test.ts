/**
 * A turn's reply on a harness whose stop names no message.
 *
 * Cursor's `stop` carries a status and a loop count and nothing the agent
 * said; the message arrives on its own, at `afterAgentResponse`. Before that
 * event was registered, every Cursor turn recorded its prompt and no reply,
 * and the Run page read each one as a question nobody answered. The recorder
 * now hands the reported message to the `turn_end` that closes the turn, so
 * the turn reads like a Claude Code or Codex turn.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import { translateCursorPayload } from "./cursor-adapter";
import { SessionRecorder } from "./recorder";

const ID = "22222222-3333-4444-5555-666666666666";
const at = "2026-09-23T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cursor",
    fleet_id: "wrk_test",
    runtime: "cursor",
    harness: "cursor",
    wrapper_version: "2.1.1",
  },
};

const decoder = new TextDecoder();

function cursorChain(scope: string) {
  const chain = new SessionRecorder({ context, harnessSessionId: ID, scope });
  const written: TachoEvent[] = [];
  const hook = (payload: Record<string, unknown>): TachoEvent[] => {
    const events = chain.ingestHook(
      translateCursorPayload({
        conversation_id: ID,
        generation_id: "gen-1",
        model: "claude-sonnet",
        cursor_version: "1.7.0",
        ...payload,
      }),
      {},
      at,
    );
    written.push(...events);
    return events;
  };
  /** The body text the recorder kept for an event, by its idempotency key. */
  const bodies = new Map<string, string>();
  const drain = () => {
    for (const body of chain.takeBodies())
      bodies.set(body.event_id_idem, decoder.decode(body.bytes));
  };
  const textOf = (event: TachoEvent | undefined): string | undefined => {
    drain();
    return event === undefined ? undefined : bodies.get(event.event_id_idem);
  };
  return { chain, written, hook, textOf };
}

describe("a Cursor turn", () => {
  it("records the prompt, the agent's message, and a turn_end carrying it", () => {
    const { written, hook, textOf } = cursorChain("cursor-turn-reply");
    hook({ hook_event_name: "sessionStart", session_id: ID });
    hook({ hook_event_name: "beforeSubmitPrompt", prompt: "fix the build" });
    hook({
      hook_event_name: "afterAgentResponse",
      text: "The build is fixed: a missing import in main.ts.",
    });
    hook({ hook_event_name: "stop", status: "completed", loop_count: 0 });

    const kinds = written.map((event) => event.kind);
    expect(kinds).toEqual([
      "agent_start",
      "turn_start",
      "oxagen:message",
      "turn_end",
    ]);
    const start = written.find((event) => event.kind === "turn_start");
    const message = written.find((event) => event.kind === "oxagen:message");
    const end = written.find((event) => event.kind === "turn_end");
    expect(textOf(start)).toBe("fix the build");
    expect(textOf(message)).toBe(
      "The build is fixed: a missing import in main.ts.",
    );
    expect(textOf(end)).toBe(
      "The build is fixed: a missing import in main.ts.",
    );
    expect(end?.content?.digest).toBe(message?.content?.digest);
    expect(verifyChain(written).ok).toBe(true);
  });

  it("keeps the message text out of the event's attributes", () => {
    const { written, hook } = cursorChain("cursor-turn-reply-attrs");
    hook({ hook_event_name: "sessionStart", session_id: ID });
    hook({ hook_event_name: "beforeSubmitPrompt", prompt: "hello" });
    hook({ hook_event_name: "afterAgentResponse", text: "secret-ish reply" });
    hook({
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_use_id: "tu_1",
      agent_message: "Listing the directory now.",
    });
    for (const event of written) {
      const attrs = JSON.stringify(event.attrs ?? {});
      expect(attrs).not.toContain("secret-ish reply");
      expect(attrs).not.toContain("Listing the directory now.");
    }
  });

  it("carries preToolUse's agent_message as a preceding message, never as the turn's reply", () => {
    const { written, hook, textOf } = cursorChain("cursor-pretooluse-message");
    hook({ hook_event_name: "sessionStart", session_id: ID });
    hook({ hook_event_name: "beforeSubmitPrompt", prompt: "clean up" });
    const fromPreToolUse = hook({
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_use_id: "tu_1",
      agent_message: "Listing the directory now.",
    });
    // A preceding oxagen:message, then the tool_requested it announced.
    expect(fromPreToolUse.map((event) => event.kind)).toEqual([
      "oxagen:message",
      "tool_requested",
    ]);
    const message = fromPreToolUse[0];
    expect(textOf(message)).toBe("Listing the directory now.");
    expect(message?.hook_event_name).toBe("PreToolUse");
    // It must not become the turn's reply: only an AgentResponse draft does.
    const [end] = hook({ hook_event_name: "stop", status: "completed" });
    expect(textOf(end)).toBeUndefined();
  });

  it("closes an unanswered turn with the last message when the next prompt arrives first", () => {
    const { written, hook, textOf } = cursorChain("cursor-turn-reply-open");
    hook({ hook_event_name: "sessionStart", session_id: ID });
    hook({ hook_event_name: "beforeSubmitPrompt", prompt: "one" });
    hook({ hook_event_name: "afterAgentResponse", text: "first draft" });
    hook({ hook_event_name: "afterAgentResponse", text: "final answer" });
    // No stop: the next prompt closes the turn.
    const next = hook({ hook_event_name: "beforeSubmitPrompt", prompt: "two" });
    expect(next.map((event) => event.kind)).toEqual(["turn_end", "turn_start"]);
    expect(textOf(next[0])).toBe("final answer");
    // The reply belongs to the turn it answered and does not leak forward.
    const end = hook({ hook_event_name: "stop", status: "completed" });
    expect(textOf(end[0])).toBeUndefined();
    expect(verifyChain(written).ok).toBe(true);
  });

  it("keeps an open turn's pending reply across a restart", () => {
    const { chain, hook } = cursorChain("cursor-turn-reply-restart");
    hook({ hook_event_name: "sessionStart", session_id: ID });
    hook({ hook_event_name: "beforeSubmitPrompt", prompt: "fix the build" });
    hook({ hook_event_name: "afterAgentResponse", text: "done" });
    // A restart between the reply and the stop: a fresh recorder restores
    // from the state the collector persisted, the way the daemon would.
    const restored = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: "cursor-turn-reply-restart",
      restore: chain.state(),
    });
    const [end] = restored.ingestHook(
      translateCursorPayload({
        conversation_id: ID,
        generation_id: "gen-1",
        model: "claude-sonnet",
        cursor_version: "1.7.0",
        hook_event_name: "stop",
        status: "completed",
        loop_count: 0,
      }),
      {},
      at,
    );
    const body = restored
      .takeBodies()
      .find((candidate) => candidate.event_id_idem === end?.event_id_idem);
    expect(body === undefined ? undefined : decoder.decode(body.bytes)).toBe(
      "done",
    );
  });

  it("puts an open turn's pending reply back on rollback", () => {
    const { chain, hook, textOf } = cursorChain("cursor-turn-reply-rollback");
    hook({ hook_event_name: "sessionStart", session_id: ID });
    hook({ hook_event_name: "beforeSubmitPrompt", prompt: "one" });
    hook({ hook_event_name: "afterAgentResponse", text: "first draft" });
    const mark = chain.markChain();
    // A second reply lands, then the write that had to follow it fails.
    hook({ hook_event_name: "afterAgentResponse", text: "final answer" });
    chain.rollbackChain(mark);
    // The retry must see the reply the mark held, not the one undone with it.
    const [end] = hook({ hook_event_name: "stop", status: "completed" });
    expect(textOf(end)).toBe("first draft");
  });

  it("prefers the stop's own message when the harness sends one", () => {
    const chain = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: "claude-stop-message",
    });
    const hook = (payload: Record<string, unknown>) =>
      chain.ingestHook({ session_id: ID, ...payload }, {}, at);
    hook({ hook_event_name: "SessionStart" });
    hook({ hook_event_name: "UserPromptSubmit", prompt: "q" });
    const [end] = hook({
      hook_event_name: "Stop",
      last_assistant_message: "the stop's own answer",
    });
    const body = chain
      .takeBodies()
      .find((candidate) => candidate.event_id_idem === end?.event_id_idem);
    expect(body === undefined ? undefined : decoder.decode(body.bytes)).toBe(
      "the stop's own answer",
    );
  });
});
