/**
 * A prompt that arrives while the previous turn is still open.
 *
 * The recorder closes the open turn with a collector `turn_end` before it
 * seals the new `turn_start`. The daemon writes only the events `ingestHook`
 * returns, so that `turn_end` must be among them. When it was sealed and not
 * returned, its seq never reached the WAL, and the control plane reported
 * "seq N+1 follows seq N-1" before every such prompt.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";

const ID = "11111111-2222-3333-4444-555555555555";
const at = "2026-09-22T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

describe("a prompt on an open turn", () => {
  it("returns the turn_end it seals, so the written chain has no gap", () => {
    const chain = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: "turn-gap",
    });
    const written: TachoEvent[] = [];
    const hook = (payload: Record<string, unknown>): TachoEvent[] => {
      const events = chain.ingestHook({ session_id: ID, ...payload }, {}, at);
      written.push(...events);
      return events;
    };

    hook({ hook_event_name: "SessionStart" });
    hook({ hook_event_name: "UserPromptSubmit", prompt: "first" });
    // No Stop hook: the first turn is still open when the next prompt lands.
    const second = hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "second",
    });

    expect(second.map((event) => event.kind)).toEqual([
      "turn_end",
      "turn_start",
    ]);
    expect(written.map((event) => event.seq)).toEqual(
      chain.sealedEvents.map((event) => event.seq),
    );
    expect(verifyChain(written).ok).toBe(true);
  });
});

describe("the ingest guard", () => {
  function started(scope: string): SessionRecorder {
    const chain = new SessionRecorder({ context, harnessSessionId: ID, scope });
    chain.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart" },
      {},
      at,
    );
    return chain;
  }

  it("writes an event a path sealed and did not return, in chain order", () => {
    const chain = started("turn-gap-guard");
    // Stand in for any future path that seals an event and forgets it: this
    // one is sealed before the hook's own event and never returned.
    const inner = Reflect.get(chain, "sealHook") as (
      ...args: unknown[]
    ) => TachoEvent[];
    Reflect.set(chain, "sealHook", (...args: unknown[]) => {
      chain.sealCollectorEvent(
        "oxagen:worktree_reconciled",
        { observed_changes_total: 0, observed_changes_truncated: false },
        { ts: at },
      );
      return inner.apply(chain, args);
    });

    const events = chain.ingestHook(
      { session_id: ID, hook_event_name: "UserPromptSubmit", prompt: "go" },
      {},
      at,
    );

    expect(events.map((event) => event.kind)).toEqual([
      "oxagen:worktree_reconciled",
      "turn_start",
    ]);
    const first = events[0]?.seq ?? -1;
    expect(events.map((event) => event.seq)).toEqual([first, first + 1]);
    const repairs = chain.takeSealRepairs();
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("oxagen:worktree_reconciled");
    expect(chain.takeSealRepairs()).toEqual([]);
  });

  it("adds nothing when every sealed event is returned", () => {
    const chain = started("turn-gap-clean");
    const written = [...chain.sealedEvents];
    written.push(
      ...chain.ingestHook(
        { session_id: ID, hook_event_name: "UserPromptSubmit", prompt: "go" },
        {},
        at,
      ),
      ...chain.finalize("completed", at),
    );
    expect(chain.takeSealRepairs()).toEqual([]);
    expect(written.map((event) => event.seq)).toEqual(
      chain.sealedEvents.map((event) => event.seq),
    );
  });
});
