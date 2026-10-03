/**
 * A Cursor subagent's chain ends at its own stop.
 *
 * Cursor's `subagentStart` names the subagent's id, and its `subagentStop`
 * does not: it carries the subagent's type and how it ended (`status`). The
 * stop used to land on the session's own chain, so the subagent's chain stayed
 * open until the session ended and was sealed `aborted` there, whatever
 * Cursor reported. The payloads are Cursor's documented shape as of
 * 2026-10-03 (https://cursor.com/docs/agent/hooks).
 */
import { describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import { translateCursorPayload } from "./cursor-adapter";
import { SessionRecorder, SUBAGENT_TYPE_AMBIGUOUS_ATTR } from "./recorder";

const CONVERSATION = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const at = "2026-10-03T10:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cursor",
    fleet_id: "wrk_test",
    runtime: "cursor",
    harness: "cursor",
    wrapper_version: "2.1.1",
  },
};

function session(): SessionRecorder {
  const chain = new SessionRecorder({
    context,
    harnessSessionId: CONVERSATION,
    scope: "host-cursor-subagent-test",
  });
  hook(chain, { hook_event_name: "sessionStart", session_id: CONVERSATION });
  return chain;
}

/** A Cursor hook, translated the way `tacho-hook` translates it. */
function hook(
  chain: SessionRecorder,
  payload: Record<string, unknown>,
): TachoEvent[] {
  return chain.ingestHook(
    translateCursorPayload({ conversation_id: CONVERSATION, ...payload }),
    {},
    at,
  );
}

const start = (subagentId: string) => ({
  hook_event_name: "subagentStart",
  subagent_id: subagentId,
  subagent_type: "explore",
  task: "Find where proration is computed",
  tool_call_id: `tc-${subagentId}`,
});

const stop = (status: string) => ({
  hook_event_name: "subagentStop",
  subagent_type: "explore",
  status,
  task: "Find where proration is computed",
  summary: "Proration lives in billing/proration.ts",
  duration_ms: 5400,
});

/** The `agent_stop` that closed one subagent's chain. */
function subagentEnd(
  events: readonly TachoEvent[],
  subagentId: string,
): TachoEvent | undefined {
  return events.find(
    (event) =>
      event.kind === "agent_stop" &&
      event.subagent?.subagent_id === subagentId,
  );
}

/** The parent chain's own `subagent_stop`. */
function parentStop(
  chain: SessionRecorder,
  events: readonly TachoEvent[],
): TachoEvent | undefined {
  return events.find(
    (event) =>
      event.kind === "subagent_stop" &&
      event.session_uuid === chain.sessionUuid,
  );
}

describe("a Cursor subagent's stop", () => {
  it("links the spawn to the call that launched it", () => {
    const chain = session();
    const events = hook(chain, start("sa-1"));
    const spawn = events.find(
      (event) =>
        event.kind === "subagent_start" &&
        event.session_uuid === chain.sessionUuid,
    );
    expect(spawn?.body).toMatchObject({ tool_use_id: "tc-sa-1" });
    expect(spawn?.attrs["hook.agent_id"]).toBe("sa-1");
  });

  it("ends the one open subagent of its type, as completed", () => {
    const chain = session();
    hook(chain, start("sa-1"));
    const events = hook(chain, stop("completed"));
    expect(subagentEnd(events, "sa-1")?.body).toMatchObject({
      session_outcome: "completed",
    });
    const own = parentStop(chain, events);
    expect(own?.attrs["hook.agent_id"]).toBe("sa-1");
    expect(own?.body).toMatchObject({ tool_status: "ok" });
    expect(chain.openChildren.has("sa-1")).toBe(false);
    // The session's end has no subagent left to seal.
    const end = hook(chain, {
      hook_event_name: "sessionEnd",
      session_id: CONVERSATION,
      reason: "completed",
    });
    expect(subagentEnd(end, "sa-1")).toBeUndefined();
  });

  it.each([
    ["error", "error"],
    ["aborted", "cancelled"],
  ])(
    "ends a subagent Cursor says ended %s as aborted, with the stop reading %s",
    (status, toolStatus) => {
      const chain = session();
      hook(chain, start("sa-1"));
      const events = hook(chain, stop(status));
      expect(subagentEnd(events, "sa-1")?.body).toMatchObject({
        session_outcome: "aborted",
      });
      expect(parentStop(chain, events)?.body).toMatchObject({
        tool_status: toolStatus,
      });
    },
  );

  it("leaves a stop two open subagents of its type could end on the session's chain", () => {
    const chain = session();
    hook(chain, start("sa-1"));
    hook(chain, start("sa-2"));
    const events = hook(chain, stop("completed"));
    const own = parentStop(chain, events);
    expect(own?.attrs[SUBAGENT_TYPE_AMBIGUOUS_ATTR]).toBe("1");
    expect(own?.attrs["hook.agent_id"]).toBeUndefined();
    expect(subagentEnd(events, "sa-1")).toBeUndefined();
    expect(subagentEnd(events, "sa-2")).toBeUndefined();
    expect([...chain.openChildren.keys()]).toEqual(["sa-1", "sa-2"]);
  });
});
