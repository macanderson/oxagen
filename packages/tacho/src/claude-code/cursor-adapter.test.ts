/**
 * The Cursor adapter is the only thing that knows Cursor's hook shape, so
 * these tests hold the three translations it owns: the session id the record
 * files a Cursor run under, the flat permission answer Cursor reads back, and
 * the `ask` that Cursor does not enforce at `preToolUse`.
 *
 * The payloads here are Cursor's documented shape (verified 2026-09-18
 * against https://cursor.com/docs/agent/hooks, fetched that day).
 */
import { describe, expect, it } from "vitest";
import {
  CURSOR_ENFORCEMENT_EVENTS,
  CURSOR_HOOK_EVENTS,
  CURSOR_TO_CLAUDE_EVENT,
  cursorAnswer,
  translateCursorPayload,
} from "./cursor-adapter";
import { hookInputSchema, normalizeHook } from "./hooks";

const PRE_TOOL_USE = {
  conversation_id: "conv_01J8",
  generation_id: "gen_04",
  hook_event_name: "preToolUse",
  cursor_version: "2026.9.10",
  workspace_roots: ["/repo/one", "/repo/two"],
  user_email: "someone@example.com",
  transcript_path: "/tmp/transcript.jsonl",
  model: "claude-opus-5",
  model_params: { temperature: 0.2 },
  tool_name: "Shell",
  tool_input: { command: "git push origin main" },
  tool_use_id: "toolu_77",
  cwd: "/repo/one",
};

describe("a Cursor payload becomes a Claude Code payload", () => {
  it("files the run under the conversation id, which is stable across turns", () => {
    const translated = translateCursorPayload(PRE_TOOL_USE) as Record<
      string,
      unknown
    >;
    expect(translated["session_id"]).toBe("conv_01J8");
    expect(translated["hook_event_name"]).toBe("PreToolUse");
    // Cursor issues the tool-use id, so nothing is derived from a digest.
    expect(translated["tool_use_id"]).toBe("toolu_77");
    expect(hookInputSchema.safeParse(translated).success).toBe(true);
  });

  it("takes sessionStart's session_id, documented as the same value", () => {
    const translated = translateCursorPayload({
      hook_event_name: "sessionStart",
      conversation_id: "conv_01J8",
      session_id: "conv_01J8",
      workspace_roots: ["/repo/one"],
    }) as Record<string, unknown>;
    expect(translated["session_id"]).toBe("conv_01J8");
    expect(translated["hook_event_name"]).toBe("SessionStart");
    // Only preToolUse carries a cwd, so the first workspace root stands in.
    expect(translated["cwd"]).toBe("/repo/one");
  });

  it("carries the generation as the turn, since it changes per user message", () => {
    const translated = translateCursorPayload(PRE_TOOL_USE) as Record<
      string,
      unknown
    >;
    expect(translated["turn_id"]).toBe("gen_04");
  });

  it("drops the user's address rather than sealing it into every frame", () => {
    const translated = translateCursorPayload(PRE_TOOL_USE) as Record<
      string,
      unknown
    >;
    expect(translated["user_email"]).toBeUndefined();
    expect(translated["model_params"]).toBeUndefined();
    const [draft] = normalizeHook(translated, {}, { sessionUuid: "uuid-1" });
    expect(JSON.stringify(draft)).not.toContain("someone@example.com");
  });

  it("seals a frame naming the effect the shell command has", () => {
    const [draft] = normalizeHook(
      translateCursorPayload(PRE_TOOL_USE),
      {},
      { sessionUuid: "uuid-1" },
    );
    expect(draft?.kind).toBe("tool_requested");
    expect(draft?.body["effect_kind"]).toBe("git_push");
    expect(draft?.body["tool_name"]).toBe("Shell");
  });

  it("returns a document that is not a Cursor hook unchanged", () => {
    expect(translateCursorPayload({ nope: 1 })).toEqual({ nope: 1 });
    // A hook event with no conversation to file it under is junk, and it
    // fails the schema the way any junk does.
    const orphan = { hook_event_name: "preToolUse" };
    expect(translateCursorPayload(orphan)).toEqual(orphan);
    expect(hookInputSchema.safeParse(orphan).success).toBe(false);
  });

  it("every registered event has a Claude Code name", () => {
    for (const event of CURSOR_HOOK_EVENTS)
      expect(CURSOR_TO_CLAUDE_EVENT[event]).toBeTruthy();
    for (const event of CURSOR_ENFORCEMENT_EVENTS)
      expect(CURSOR_HOOK_EVENTS).toContain(event);
  });
});

describe("a decision becomes the flat answer Cursor reads", () => {
  const deny = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "This agent may not push to main.",
    },
  };

  it("round-trips a deny into Cursor's permission object", () => {
    const answer = JSON.parse(cursorAnswer(deny, "PreToolUse")) as Record<
      string,
      unknown
    >;
    expect(answer).toEqual({
      permission: "deny",
      user_message: "This agent may not push to main.",
      agent_message: "This agent may not push to main.",
    });
  });

  it("answers an allow explicitly, because failClosed counts no output as a failure", () => {
    expect(JSON.parse(cursorAnswer({}, "PreToolUse"))).toEqual({
      permission: "allow",
    });
  });

  it("degrades an ask to a deny that says a person must approve", () => {
    // Cursor: "'ask' is accepted by the schema but not enforced for
    // `preToolUse` today." An ask that became an allow would be a mandate
    // that does not hold, so it becomes a deny and the reason says why.
    const answer = JSON.parse(
      cursorAnswer(
        {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "Pushing to main needs approval.",
          },
        },
        "PreToolUse",
      ),
    ) as Record<string, string>;
    expect(answer["permission"]).toBe("deny");
    expect(answer["user_message"]).toContain("Pushing to main needs approval.");
    expect(answer["user_message"]).toContain("approve this in Oxagen");
    expect(answer["agent_message"]).toBe(answer["user_message"]);
  });

  it("turns an operator stop into a refusal at the tool call", () => {
    const answer = JSON.parse(
      cursorAnswer(
        { continue: false, stopReason: "This host is paused." },
        "PreToolUse",
      ),
    ) as Record<string, string>;
    expect(answer["permission"]).toBe("deny");
    expect(answer["user_message"]).toBe("This host is paused.");
  });

  it("blocks a prompt with Cursor's continue field", () => {
    expect(
      JSON.parse(
        cursorAnswer(
          { decision: "block", reason: "This session is paused." },
          "UserPromptSubmit",
        ),
      ),
    ).toEqual({ continue: false, user_message: "This session is paused." });
    expect(JSON.parse(cursorAnswer({}, "UserPromptSubmit"))).toEqual({
      continue: true,
    });
  });

  it("puts the session's context, and a stop, into sessionStart prose", () => {
    expect(
      JSON.parse(
        cursorAnswer(
          {
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: "Mandate: no pushes to main.",
            },
          },
          "SessionStart",
        ),
      ),
    ).toEqual({ additional_context: "Mandate: no pushes to main." });
    // Cursor's sessionStart answer has no veto field, so a suspended host is
    // told in prose and refused at every later tool call instead.
    const stopped = JSON.parse(
      cursorAnswer(
        { continue: false, stopReason: "This host is suspended." },
        "SessionStart",
      ),
    ) as Record<string, string>;
    expect(stopped["additional_context"]).toContain("This host is suspended.");
    expect(stopped["additional_context"]).toContain(
      "Tool calls will be refused.",
    );
  });

  it("answers a telemetry event with an empty document", () => {
    expect(cursorAnswer({}, "PostToolUse")).toBe("{}\n");
  });
});
