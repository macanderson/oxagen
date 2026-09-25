/**
 * The recorder's chain mark: what a rollback puts back after a write that
 * had to follow a seal failed.
 *
 * A seal moves the cursor in memory and the WAL write comes after it, so
 * every caller that seals before it writes needs a way to put one chain back
 * without touching another session's. What is asserted here is that the
 * rolled-back chain seals its replacement at the same position, that a
 * subagent chain rolls back with its parent, and that a sibling recorder is
 * left exactly as it was.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";

const ID = "11111111-2222-3333-4444-555555555555";
const SIBLING_ID = "99999999-8888-7777-6666-555555555555";
const SCOPE = "host-rollback-test";
const at = "2026-09-21T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

function toolCall(name: string) {
  return {
    tool_name: name,
    tool_source: "mcp",
    mcp_server_name: "oxagen",
    mcp_tool_name: name,
    tool_status: "ok",
    tool_duration_ms: 1,
  };
}

function bytes(text: string) {
  return {
    content_type: "text/plain",
    bytes: new TextEncoder().encode(text),
  };
}

function recorder(harnessSessionId: string): SessionRecorder {
  const made = new SessionRecorder({ context, harnessSessionId, scope: SCOPE });
  made.ingestHook(
    { session_id: harnessSessionId, hook_event_name: "SessionStart" },
    {},
    at,
  );
  return made;
}

describe("the recorder's chain mark", () => {
  it("seals the replacement at the position the rolled-back event held", () => {
    const chain = recorder(ID);
    const mark = chain.markChain();
    const abandoned = chain.sealCollectorEvent(
      "oxagen:worktree_reconciled",
      { observed_changes_total: 0, observed_changes_truncated: false },
      { ts: at },
    );
    chain.rollbackChain(mark);
    expect(chain.chainCursor).toEqual(mark.cursor);
    expect(chain.sealedEvents).toHaveLength(mark.events);
    const replacement = chain.sealCollectorEvent(
      "oxagen:worktree_reconciled",
      { observed_changes_total: 1, observed_changes_truncated: false },
      { ts: at },
    );
    expect(replacement.seq).toBe(abandoned.seq);
    expect(replacement.prev_hash).toBe(abandoned.prev_hash);
    expect(verifyChain([...chain.sealedEvents]).ok).toBe(true);
  });

  it("puts a turn and its terminal flags back", () => {
    const chain = recorder(ID);
    chain.ingestHook(
      { session_id: ID, hook_event_name: "UserPromptSubmit", prompt: "go" },
      {},
      at,
    );
    const mark = chain.markChain();
    chain.sealCollectorEvent(
      "agent_stop",
      { session_outcome: "completed" },
      {
        ts: at,
      },
    );
    expect(chain.hasStopped).toBe(true);
    chain.rollbackChain(mark);
    expect(chain.hasStopped).toBe(false);
    expect(chain.hasStarted).toBe(true);
    expect(chain.sealedEvents.at(-1)?.turn?.turn_seq).toBe(1);
  });

  it("rolls back a subagent chain that opened after the mark", () => {
    const chain = recorder(ID);
    const mark = chain.markChain();
    chain.ingestHook(
      {
        session_id: ID,
        hook_event_name: "SubagentStart",
        agent_id: "child",
        agent_type: "reviewer",
      },
      {},
      at,
    );
    expect(chain.openChildren.size).toBe(1);
    chain.rollbackChain(mark);
    expect(chain.openChildren.size).toBe(0);
    expect(chain.chainCursor).toEqual(mark.cursor);
    expect(chain.takeBodies()).toEqual([]);
  });

  it("puts back a body the failed caller had already drained", () => {
    // The daemon seals, drains the bodies into the write, and only then
    // learns the write failed. A body sealed before the mark belongs to an
    // event the chain still holds, so the rollback has to return it even
    // though `takeBodies` took it out of the recorder.
    const chain = recorder(ID);
    const kept = chain.sealCollectorEvent("tool_call", toolCall("kept"), {
      ts: at,
      content: bytes("kept"),
    });
    const mark = chain.markChain();
    chain.sealCollectorEvent("tool_call", toolCall("abandoned"), {
      ts: at,
      content: bytes("abandoned"),
    });
    expect(chain.takeBodies().map((body) => body.seq)).toEqual([
      kept.seq,
      kept.seq + 1,
    ]);
    chain.rollbackChain(mark);
    const restored = chain.takeBodies();
    expect(restored.map((body) => body.event_id_idem)).toEqual([
      kept.event_id_idem,
    ]);
    expect(new TextDecoder().decode(restored[0]?.bytes)).toBe("kept");
  });

  it("leaves another session's recorder where it stood", () => {
    const chain = recorder(ID);
    const sibling = recorder(SIBLING_ID);
    const mark = chain.markChain();
    const siblingEvent = sibling.sealCollectorEvent(
      "oxagen:worktree_reconciled",
      { observed_changes_total: 0, observed_changes_truncated: false },
      { ts: at },
    );
    chain.sealCollectorEvent(
      "oxagen:worktree_reconciled",
      { observed_changes_total: 0, observed_changes_truncated: false },
      { ts: at },
    );
    chain.rollbackChain(mark);
    expect(sibling.sealedEvents.at(-1)).toBe(siblingEvent);
    expect(sibling.chainCursor.seq).toBe(siblingEvent.seq + 1);
  });
});
