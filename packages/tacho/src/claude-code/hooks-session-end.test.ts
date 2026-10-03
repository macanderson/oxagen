/**
 * The outcome a session's `agent_stop` carries, read from the reason its
 * harness gave at `SessionEnd`. Ingest copies the outcome onto the run, so a
 * reason read wrongly marks a finished run aborted (#5381). Claude Code and
 * Cursor each name a normal end in their own words, and both lists are held
 * here. The Cursor reasons go through the adapter first, the way the hook
 * client sends them. Cursor's reasons come from its hook reference as of
 * 2026-10-03.
 */
import { describe, expect, it } from "vitest";
import { translateCursorPayload } from "./cursor-adapter";
import { normalizeHook } from "./hooks";

const SESSION = "00000000-0000-4000-8000-000000000001";
const OPTIONS = { sessionUuid: "11111111-1111-4111-8111-111111111111" };

/** The one draft a SessionEnd seals, from a payload in Claude Code's shape. */
function stopOf(payload: unknown) {
  const drafts = normalizeHook(payload, {}, OPTIONS);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.kind).toBe("agent_stop");
  return drafts[0];
}

function claudeCodeEnd(reason: string) {
  return stopOf({
    session_id: SESSION,
    hook_event_name: "SessionEnd",
    cwd: "/home/dev/proj",
    reason,
  });
}

function cursorEnd(reason: string) {
  return stopOf(
    translateCursorPayload({
      conversation_id: "conv-1",
      session_id: "conv-1",
      hook_event_name: "sessionEnd",
      workspace_roots: ["/repo/one"],
      reason,
    }),
  );
}

describe("the outcome a SessionEnd reason seals", () => {
  it.each(["prompt_input_exit", "clear", "other", "resume"])(
    "seals Claude Code's %j as completed",
    (reason) => {
      const draft = claudeCodeEnd(reason);
      expect(draft?.body).toMatchObject({
        session_end_reason: reason,
        session_outcome: "completed",
      });
      expect(draft?.hook_source_kind).toBe(reason);
    },
  );

  it.each(["logout", "bypass_permissions_disabled"])(
    "seals Claude Code's %j as aborted (negative)",
    (reason) => {
      expect(claudeCodeEnd(reason)?.body).toMatchObject({
        session_end_reason: reason,
        session_outcome: "aborted",
      });
    },
  );

  it.each(["completed", "window_close", "user_close"])(
    "seals Cursor's %j as completed",
    (reason) => {
      const draft = cursorEnd(reason);
      expect(draft?.body).toMatchObject({
        session_end_reason: reason,
        session_outcome: "completed",
      });
      expect(draft?.hook_source_kind).toBe(reason);
    },
  );

  // `crashed` is kept for a chain whose harness never reported an end.
  // Cursor reported this one, and the reason keeps the word `error`.
  it.each(["aborted", "error"])(
    "seals Cursor's %j as aborted, never crashed (negative)",
    (reason) => {
      expect(cursorEnd(reason)?.body).toMatchObject({
        session_end_reason: reason,
        session_outcome: "aborted",
      });
    },
  );

  it("reads a reason it does not know as aborted (negative)", () => {
    expect(claudeCodeEnd("something_new")?.body).toMatchObject({
      session_end_reason: "something_new",
      session_outcome: "aborted",
    });
  });
});
