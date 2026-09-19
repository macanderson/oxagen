/**
 * The Cursor adapter in both directions: Cursor's camelCase payload becomes
 * Claude Code's shape for the recorder and the daemon, and Claude Code's
 * answer becomes the flat document Cursor reads for each event.
 */
import { describe, expect, it } from "vitest";
import {
  CURSOR_EVENT_NAMES,
  cursorAnswer,
  cursorToolName,
  translateCursorPayload,
} from "./cursor-adapter";
import { hookInputSchema } from "./hooks";

const COMMON = {
  conversation_id: "conv-1",
  generation_id: "gen-1",
  model: "claude-sonnet",
  cursor_version: "2.4.0",
  workspace_roots: ["/repo"],
  user_email: null,
  transcript_path: null,
};

describe("translateCursorPayload", () => {
  it("names the session by conversation_id and the event in Claude Code's words", () => {
    for (const [cursor, claude] of Object.entries(CURSOR_EVENT_NAMES)) {
      const out = translateCursorPayload({
        ...COMMON,
        hook_event_name: cursor,
      }) as Record<string, unknown>;
      expect(out).toMatchObject({
        session_id: "conv-1",
        hook_event_name: claude,
        cursor_event: cursor,
        cwd: "/repo",
      });
      expect(hookInputSchema.safeParse(out).success).toBe(true);
    }
  });

  it("renames a shell call to Bash so one rule governs every harness", () => {
    const out = translateCursorPayload({
      ...COMMON,
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "git push" },
      tool_use_id: "tu-1",
      cwd: "/repo/sub",
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      tool_name: "Bash",
      cursor_tool_name: "Shell",
      tool_input: { command: "git push" },
      tool_use_id: "tu-1",
      // The event's own cwd wins over the workspace root.
      cwd: "/repo/sub",
    });
    expect(out["conversation_id"]).toBeUndefined();
  });

  it("carries a tool's output, duration and subagent identity under Claude Code's names", () => {
    const post = translateCursorPayload({
      ...COMMON,
      hook_event_name: "postToolUse",
      tool_name: "Read",
      tool_input: { path: "a.ts" },
      tool_output: "contents",
      duration: 12,
    }) as Record<string, unknown>;
    expect(post).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_response: "contents",
      duration_ms: 12,
    });
    const sub = translateCursorPayload({
      ...COMMON,
      hook_event_name: "subagentStart",
      subagent_id: "sa-1",
      subagent_type: "explore",
    }) as Record<string, unknown>;
    expect(sub).toMatchObject({ agent_id: "sa-1", agent_type: "explore" });
  });

  it("keeps Cursor's own session id as an attribute", () => {
    const out = translateCursorPayload({
      ...COMMON,
      hook_event_name: "sessionStart",
      session_id: "cursor-session",
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      session_id: "conv-1",
      cursor_session_id: "cursor-session",
    });
  });

  it("drops a signed-in address so it never lands in event attributes", () => {
    const out = translateCursorPayload({
      ...COMMON,
      hook_event_name: "preToolUse",
      tool_name: "Read",
      tool_input: { path: "a.ts" },
      user_email: "mac@example.com",
    }) as Record<string, unknown>;
    expect(out["user_email"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("mac@example.com");
  });

  it("parses MCP arguments sent as a JSON string", () => {
    const out = translateCursorPayload({
      ...COMMON,
      hook_event_name: "preToolUse",
      tool_name: "MCP:search",
      mcp_server_name: "linear",
      tool_input: '{"query":"bug"}',
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      tool_name: "mcp__linear__search",
      tool_input: { query: "bug" },
    });
    const junk = translateCursorPayload({
      ...COMMON,
      hook_event_name: "preToolUse",
      tool_name: "Delete",
      tool_input: "not json",
    }) as Record<string, unknown>;
    expect(junk).toMatchObject({
      tool_name: "Delete",
      tool_input: { value: "not json" },
    });
  });

  it("returns anything that is not a Cursor agent payload unchanged", () => {
    expect(translateCursorPayload("text")).toBe("text");
    const claude = { session_id: "s", hook_event_name: "PreToolUse" };
    expect(translateCursorPayload(claude)).toBe(claude);
    const tab = { ...COMMON, hook_event_name: "afterTabFileEdit" };
    expect(translateCursorPayload(tab)).toBe(tab);
  });
});

describe("cursorToolName", () => {
  it("maps built-ins, keeps an MCP tool whose server is unknown as sent", () => {
    expect(cursorToolName("Shell")).toBe("Bash");
    expect(cursorToolName("Write")).toBe("Write");
    expect(cursorToolName("MCP:search", "github")).toBe("mcp__github__search");
    expect(cursorToolName("MCP:search")).toBe("MCP:search");
    expect(cursorToolName("Delete")).toBe("Delete");
  });
});

describe("cursorAnswer", () => {
  const pre = (decision: string, reason?: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
    },
  });

  it("always answers a permission event with allow or deny", () => {
    expect(
      JSON.parse(cursorAnswer(pre("deny", "no push"), "PreToolUse")),
    ).toEqual({
      permission: "deny",
      user_message: "no push",
      agent_message: "no push",
    });
    expect(JSON.parse(cursorAnswer(pre("allow"), "PreToolUse"))).toEqual({
      permission: "allow",
    });
    // No decision is not a block: Cursor reads a non-conforming answer to a
    // permission event as one.
    expect(JSON.parse(cursorAnswer({}, "PreToolUse"))).toEqual({
      permission: "allow",
    });
    expect(JSON.parse(cursorAnswer({}, "SubagentStart"))).toEqual({
      permission: "allow",
    });
  });

  it("refuses an ask, because Cursor cannot pause for approval on preToolUse", () => {
    const answer = JSON.parse(
      cursorAnswer(pre("ask", "needs a reviewer"), "PreToolUse"),
    ) as Record<string, string>;
    expect(answer["permission"]).toBe("deny");
    expect(answer["user_message"]).toMatch(/^needs a reviewer/);
  });

  it("refuses a tool call while the session is stopped", () => {
    expect(
      JSON.parse(
        cursorAnswer({ continue: false, stopReason: "paused" }, "PreToolUse"),
      ),
    ).toMatchObject({ permission: "deny", user_message: "paused" });
  });

  it("blocks or passes a prompt with continue", () => {
    expect(
      JSON.parse(
        cursorAnswer(
          { decision: "block", reason: "host paused" },
          "UserPromptSubmit",
        ),
      ),
    ).toEqual({ continue: false, user_message: "host paused" });
    expect(JSON.parse(cursorAnswer({}, "UserPromptSubmit"))).toEqual({
      continue: true,
    });
  });

  it("tells the agent at session start why its calls will be refused, since it cannot veto the start", () => {
    expect(
      JSON.parse(
        cursorAnswer(
          { continue: false, stopReason: "Host revoked." },
          "SessionStart",
        ),
      ),
    ).toEqual({
      additional_context: "Oxagen: Host revoked. Tool calls will be refused.",
    });
    expect(
      JSON.parse(
        cursorAnswer(
          {
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: "Governed.",
            },
          },
          "SessionStart",
        ),
      ),
    ).toEqual({ additional_context: "Governed." });
    expect(JSON.parse(cursorAnswer({}, "SessionStart"))).toEqual({});
  });

  it("turns a blocked stop into a follow-up message", () => {
    expect(
      JSON.parse(
        cursorAnswer({ decision: "block", reason: "run the tests" }, "Stop"),
      ),
    ).toEqual({ followup_message: "run the tests" });
    expect(JSON.parse(cursorAnswer({}, "Stop"))).toEqual({});
  });

  it("passes post-tool context through and answers telemetry events with nothing", () => {
    expect(
      JSON.parse(
        cursorAnswer(
          { hookSpecificOutput: { additionalContext: "note" } },
          "PostToolUse",
        ),
      ),
    ).toEqual({ additional_context: "note" });
    expect(JSON.parse(cursorAnswer({}, "PostToolUseFailure"))).toEqual({});
    expect(cursorAnswer({}, "SessionEnd")).toBe("{}\n");
  });
});
