import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { sessionUuid } from "../ids";
import type { ClaudeCodeContext } from "./context";
import { type RecorderState, SessionRecorder } from "./recorder";

const ID = "11111111-2222-3333-4444-555555555555";
const SCOPE = "host-identity-test";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.codex",
    fleet_id: "wrk_test",
    runtime: "codex",
    harness: "codex",
    wrapper_version: "2.1.1",
  },
};
const options = { context, harnessSessionId: ID, scope: SCOPE };
const at = "2026-09-20T00:00:00.000Z";

function removeSavedIds(state: RecorderState): void {
  delete state.sessionUuid;
  for (const child of Object.values(state.children))
    removeSavedIds(child.state);
}

function start(recorder: SessionRecorder): void {
  recorder.ingestHook(
    { session_id: ID, hook_event_name: "SessionStart" },
    {},
    at,
  );
  recorder.ingestHook(
    { session_id: ID, hook_event_name: "SubagentStart", agent_id: "child" },
    {},
    at,
  );
}

describe("recorder identity across upgrades", () => {
  it.each([false, true])(
    "continues parent and child chains after restart, legacy=%s",
    (legacy) => {
      const blank = new SessionRecorder(options).state();
      removeSavedIds(blank);
      const before = new SessionRecorder({
        ...options,
        ...(legacy ? { restore: blank } : {}),
      });
      start(before);
      const snapshot = before.snapshot();
      const saved = before.state();
      if (legacy) removeSavedIds(saved);
      const restored = new SessionRecorder({ ...options, restore: saved });
      expect(restored.sessionUuid).toBe(before.sessionUuid);
      expect(
        restored.snapshot().children.map((child) => child.sessionUuid),
      ).toEqual(snapshot.children.map((child) => child.sessionUuid));
      expect(snapshot.children).toHaveLength(1);
      expect(before.sessionUuid).toBe(
        sessionUuid(SCOPE, legacy ? ID : `codex/${ID}`),
      );
      if (legacy)
        expect(snapshot.children[0]?.sessionUuid).toBe(
          sessionUuid(SCOPE, `${ID}/agent/child`),
        );
      const terminal = restored.finalize("completed", at);
      for (const chain of [snapshot, ...snapshot.children]) {
        expect(
          verifyChain(
            [
              ...chain.events,
              ...terminal.filter(
                (event) => event.session_uuid === chain.sessionUuid,
              ),
            ],
            { expectGenesis: true },
          ).violations,
        ).toEqual([]);
      }
      expect(restored.state().sessionUuid).toBe(before.sessionUuid);
    },
  );

  it("refuses an invalid persisted UUID", () => {
    const saved = new SessionRecorder(options).state();
    saved.sessionUuid = "not-a-uuid";
    expect(() => new SessionRecorder({ ...options, restore: saved })).toThrow();
  });
});
