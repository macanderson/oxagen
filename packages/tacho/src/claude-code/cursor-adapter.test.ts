/**
 * The Cursor adapter is the only thing that knows Cursor's hook shape, so
 * these tests hold what it owns in both directions: the session id and
 * translated members the record files a Cursor run under, and the flat
 * answer Cursor reads back for each event, including the `ask` that Cursor
 * does not enforce at `preToolUse`.
 *
 * The payloads here are Cursor's documented shape (verified 2026-09-18
 * against https://cursor.com/docs/agent/hooks, fetched that day). The prompt
 * source tests at the end use Cursor 3.22.12's payloads as its shipped bundle
 * builds them.
 */
import { describe, expect, it } from "vitest";
import { digestText } from "./context";
import {
  CURSOR_ENFORCEMENT_EVENTS,
  CURSOR_HOOK_EVENTS,
  CURSOR_TO_CLAUDE_EVENT,
  cursorAnswer,
  cursorToolName,
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
    // A shell call is renamed to Bash so one policy rule governs both
    // harnesses, and the original name survives as an attribute.
    expect(translated["tool_name"]).toBe("Bash");
    expect(translated["cursor_tool_name"]).toBe("Shell");
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
    expect(translated["cursor_session_id"]).toBe("conv_01J8");
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
    expect(draft?.body["tool_name"]).toBe("Bash");
  });

  it("carries a tool's output, duration and subagent identity under Claude Code's names", () => {
    const post = translateCursorPayload({
      conversation_id: "conv-1",
      hook_event_name: "postToolUse",
      tool_name: "Read",
      tool_input: { path: "a.ts" },
      tool_output: "contents",
      duration: 12,
    }) as Record<string, unknown>;
    expect(post).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: "contents",
      duration_ms: 12,
    });
    const sub = translateCursorPayload({
      conversation_id: "conv-1",
      hook_event_name: "subagentStart",
      subagent_id: "sa-1",
      subagent_type: "explore",
    }) as Record<string, unknown>;
    expect(sub).toMatchObject({ agent_id: "sa-1", agent_type: "explore" });
  });

  it("parses MCP arguments sent as a JSON string, and renames the tool", () => {
    const out = translateCursorPayload({
      conversation_id: "conv-1",
      hook_event_name: "preToolUse",
      tool_name: "MCP:search",
      mcp_server_name: "linear",
      tool_input: '{"query":"bug"}',
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      tool_name: "mcp__linear__search",
      cursor_tool_name: "MCP:search",
      tool_input: { query: "bug" },
    });
    const junk = translateCursorPayload({
      conversation_id: "conv-1",
      hook_event_name: "preToolUse",
      tool_name: "Delete",
      tool_input: "not json",
    }) as Record<string, unknown>;
    expect(junk).toMatchObject({
      tool_name: "Delete",
      tool_input: { value: "not json" },
    });
  });

  it("returns a document that is not a Cursor hook unchanged", () => {
    expect(translateCursorPayload({ nope: 1 })).toEqual({ nope: 1 });
    // A hook event with no conversation to file it under is junk, and it
    // fails the schema the way any junk does.
    const orphan = { hook_event_name: "preToolUse" };
    expect(translateCursorPayload(orphan)).toEqual(orphan);
    expect(hookInputSchema.safeParse(orphan).success).toBe(false);
    // Cursor events Oxagen does not register (a tab edit, for instance) pass
    // through unchanged rather than being coerced into a shape not theirs.
    const tab = { conversation_id: "conv-1", hook_event_name: "afterTabFileEdit" };
    expect(translateCursorPayload(tab)).toEqual(tab);
    // Not a record at all.
    expect(translateCursorPayload("text")).toBe("text");
  });

  it("every registered event has a Claude Code name", () => {
    for (const event of CURSOR_HOOK_EVENTS)
      expect(CURSOR_TO_CLAUDE_EVENT[event]).toBeTruthy();
    for (const event of CURSOR_ENFORCEMENT_EVENTS)
      expect(CURSOR_HOOK_EVENTS).toContain(event);
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
    // SubagentStart is a permission event too (see the module comment).
    expect(JSON.parse(cursorAnswer({}, "SubagentStart"))).toEqual({
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
    expect(JSON.parse(cursorAnswer({}, "SessionStart"))).toEqual({});
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

  it("turns a blocked stop into a follow-up message, and passes an empty answer through", () => {
    expect(
      JSON.parse(
        cursorAnswer({ decision: "block", reason: "run the tests" }, "Stop"),
      ),
    ).toEqual({ followup_message: "run the tests" });
    expect(cursorAnswer({}, "Stop")).toBe("{}\n");
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

/**
 * Cursor 3.22.12's payloads, built the way its shipped bundle builds them
 * (read 2026-10-01): the event's own members first, then the members every
 * agent hook gets. In 3.22.12 that includes `session_id` on every event, set
 * to the conversation id.
 */
const CONVERSATION = "3f9c2a6e-5b1d-4c8e-9a70-1d2e3f405162";
const CURSOR_3_22_COMMON = {
  session_id: CONVERSATION,
  cursor_version: "3.22.12",
  workspace_roots: ["/Users/kim/repo"],
  user_email: null,
  transcript_path: "/Users/kim/.cursor/projects/repo/transcript.jsonl",
};
const MODEL = {
  model: "claude-4.5-sonnet-thinking",
  model_id: "claude-sonnet-4-5",
  model_params: [{ id: "thinking", value: "true" }],
};

describe("who sent a prompt", () => {
  it("adds no source to a prompt, because Cursor sends none", () => {
    // A typed prompt and a stop hook's follow-up both arrive in this shape:
    // Cursor submits the follow-up through the same path and passes the hook
    // no mark that says which one it is.
    const translated = translateCursorPayload({
      conversation_id: CONVERSATION,
      generation_id: "gen-1",
      ...MODEL,
      composer_mode: "agent",
      prompt: "fix the failing test in src/app.ts",
      attachments: [{ type: "file", file_path: "/Users/kim/repo/src/app.ts" }],
      ...CURSOR_3_22_COMMON,
      hook_event_name: "beforeSubmitPrompt",
    }) as Record<string, unknown>;
    expect(translated["hook_event_name"]).toBe("UserPromptSubmit");
    expect(translated).not.toHaveProperty("prompt_source");
    expect(translated).not.toHaveProperty("prompt_origin");

    const [draft] = normalizeHook(translated, {}, { sessionUuid: "uuid-1" });
    expect(draft?.kind).toBe("turn_start");
    expect(draft?.body["prompt_digest"]).toBeDefined();
    expect(draft?.body).not.toHaveProperty("prompt_source");
    expect(draft?.body).not.toHaveProperty("prompt_origin");
    // The mode says how the agent works, not who sent the prompt.
    expect(draft?.attrs["hook.composer_mode"]).toBe("agent");
  });

  it("keeps the automation marks Cursor does send as attributes", () => {
    const [start] = normalizeHook(
      translateCursorPayload({
        conversation_id: CONVERSATION,
        generation_id: "",
        ...MODEL,
        is_background_agent: true,
        composer_mode: "agent",
        ...CURSOR_3_22_COMMON,
        hook_event_name: "sessionStart",
      }),
      {},
      { sessionUuid: "uuid-1" },
    );
    expect(start?.kind).toBe("agent_start");
    expect(start?.attrs["hook.is_background_agent"]).toBe("true");
    expect(start?.attrs["hook.composer_mode"]).toBe("agent");

    const [end] = normalizeHook(
      translateCursorPayload({
        status: "completed",
        loop_count: 1,
        conversation_id: CONVERSATION,
        generation_id: "gen-2",
        ...MODEL,
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        ...CURSOR_3_22_COMMON,
        hook_event_name: "stop",
      }),
      {},
      { sessionUuid: "uuid-1" },
    );
    expect(end?.kind).toBe("turn_end");
    // Above 0: a stop hook's follow-up started the turn this stop ends.
    expect(end?.attrs["hook.loop_count"]).toBe("1");
    expect(end?.body).not.toHaveProperty("prompt_source");
    expect(end?.body).not.toHaveProperty("prompt_origin");
  });
});

/**
 * Cursor's subagent and error text has no body member, so whatever the
 * adapter passes through lands in a `hook.*` attribute. Attributes skip the
 * retention mandate, so the text must leave the adapter as a digest and a
 * length (#5381). The members are the ones Cursor's hook reference lists as
 * of 2026-10-03.
 */
describe("Cursor's free text reaches the record only as a digest", () => {
  const TASK = "Rewrite src/billing.ts and keep the webhook secret in .env";
  const DESCRIPTION = "Billing refactor helper for the proration bug";
  const SUMMARY = "Moved proration into billing/proration.ts and added tests";

  it("digests a subagent's task, description and summary", () => {
    const translated = translateCursorPayload({
      conversation_id: CONVERSATION,
      generation_id: "gen-3",
      ...MODEL,
      subagent_type: "explore",
      status: "completed",
      task: TASK,
      description: DESCRIPTION,
      summary: SUMMARY,
      duration_ms: 5400,
      message_count: 6,
      tool_call_count: 4,
      ...CURSOR_3_22_COMMON,
      hook_event_name: "subagentStop",
    }) as Record<string, unknown>;
    expect(translated["hook_event_name"]).toBe("SubagentStop");
    expect(translated["task"]).toBeUndefined();
    expect(translated["description"]).toBeUndefined();
    expect(translated["summary"]).toBeUndefined();

    const drafts = normalizeHook(translated, {}, { sessionUuid: "uuid-1" });
    expect(drafts).toHaveLength(1);
    const [stop] = drafts;
    expect(stop?.kind).toBe("subagent_stop");
    const sealed = JSON.stringify(stop);
    for (const text of [TASK, DESCRIPTION, SUMMARY])
      expect(sealed).not.toContain(text);
    expect(stop?.attrs["hook.task"]).toBeUndefined();
    expect(stop?.attrs["hook.description"]).toBeUndefined();
    expect(stop?.attrs["hook.summary"]).toBeUndefined();
    expect(stop?.attrs).toMatchObject({
      "hook.task_digest": digestText(TASK),
      "hook.task_length": String(TASK.length),
      "hook.description_digest": digestText(DESCRIPTION),
      "hook.description_length": String(DESCRIPTION.length),
      "hook.summary_digest": digestText(SUMMARY),
      "hook.summary_length": String(SUMMARY.length),
    });
  });

  it("digests the task a subagent starts with", () => {
    const [start] = normalizeHook(
      translateCursorPayload({
        conversation_id: CONVERSATION,
        subagent_id: "sa-1",
        subagent_type: "explore",
        task: TASK,
        ...CURSOR_3_22_COMMON,
        hook_event_name: "subagentStart",
      }),
      {},
      { sessionUuid: "uuid-1" },
    );
    expect(start?.kind).toBe("subagent_start");
    expect(JSON.stringify(start)).not.toContain(TASK);
    expect(start?.attrs["hook.task"]).toBeUndefined();
    expect(start?.attrs["hook.task_digest"]).toBe(digestText(TASK));
    expect(start?.attrs["hook.task_length"]).toBe(String(TASK.length));
  });

  it("reads a failed tool call's error_message as the tool error", () => {
    const error =
      "ENOENT: no such file or directory, open '/Users/kim/repo/.env.local'";
    const translated = translateCursorPayload({
      conversation_id: CONVERSATION,
      generation_id: "gen-3",
      tool_name: "Read",
      tool_input: { path: ".env.local" },
      tool_use_id: "toolu_9",
      cwd: "/Users/kim/repo",
      error_message: error,
      duration: 3,
      ...CURSOR_3_22_COMMON,
      hook_event_name: "postToolUseFailure",
    }) as Record<string, unknown>;
    expect(translated["hook_event_name"]).toBe("PostToolUseFailure");
    expect(translated["error"]).toBe(error);
    expect(translated["error_message"]).toBeUndefined();

    const drafts = normalizeHook(translated, {}, { sessionUuid: "uuid-1" });
    // A failed call seals no effect frame beside its tool_call.
    expect(drafts).toHaveLength(1);
    const [failed] = drafts;
    expect(failed?.kind).toBe("tool_call");
    expect(failed?.body).toMatchObject({
      tool_status: "error",
      tool_error_class: "ENOENT",
      tool_error_message_digest: digestText(error),
    });
    expect(failed?.attrs["hook.error_message"]).toBeUndefined();
    expect(failed?.attrs["hook.error"]).toBeUndefined();
    // The frame's content holds the call's input, not the error, so only the
    // body and the attributes are read here.
    const kept = JSON.stringify({ body: failed?.body, attrs: failed?.attrs });
    expect(kept).not.toContain(error);
  });

  it("digests a session's error_message, which no body member reads", () => {
    const error = "Agent loop failed while editing /Users/kim/repo/plan.md";
    const [end] = normalizeHook(
      translateCursorPayload({
        conversation_id: CONVERSATION,
        reason: "error",
        error_message: error,
        ...CURSOR_3_22_COMMON,
        hook_event_name: "sessionEnd",
      }),
      {},
      { sessionUuid: "uuid-1" },
    );
    expect(end?.kind).toBe("agent_stop");
    expect(end?.body).toMatchObject({
      session_end_reason: "error",
      session_outcome: "aborted",
    });
    expect(JSON.stringify(end)).not.toContain(error);
    expect(end?.attrs["hook.error_message"]).toBeUndefined();
    expect(end?.attrs["hook.error_message_digest"]).toBe(digestText(error));
    expect(end?.attrs["hook.error_message_length"]).toBe(
      String(error.length),
    );
  });
});
