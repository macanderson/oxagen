/**
 * The Stella adapter: payload translation into Claude Code's hook shape,
 * the pid walk past the shell Stella runs hooks through, and every answer
 * translation back into Stella's decision vocabulary.
 */
import { describe, expect, it } from "vitest";
import { hookInputSchema } from "./hooks";
import {
  parseAnswerBody,
  parsePsLine,
  psLookup,
  stellaAnswer,
  stellaHarnessPid,
  stellaSessionId,
  stellaToolUseId,
  translateStellaPayload,
} from "./stella-adapter";

describe("stella pid", () => {
  it("parses ps output and looks up a real process", () => {
    expect(parsePsLine("  812 /bin/zsh\n")).toEqual({
      ppid: 812,
      comm: "/bin/zsh",
    });
    expect(parsePsLine("")).toBeUndefined();
    if (process.platform !== "win32") {
      expect(psLookup(process.pid)?.ppid).toBe(process.ppid);
      // A pid nobody holds: ps exits non-zero.
      expect(psLookup(2_147_000_000)).toBeUndefined();
    }
  });

  it("walks past the shell to Stella, and uses the parent otherwise", () => {
    const table: Record<number, { ppid: number; comm: string }> = {
      10: { ppid: 500, comm: "-zsh" },
      11: { ppid: 501, comm: "/bin/bash" },
      12: { ppid: 1, comm: "sh" },
      13: { ppid: 502, comm: "/Users/dev/.cargo/bin/stella" },
      14: { ppid: 503, comm: "dash" },
    };
    const lookups: number[] = [];
    const lookup = (pid: number) => {
      lookups.push(pid);
      return table[pid];
    };
    expect(stellaHarnessPid(10, "darwin", lookup)).toBe(500);
    expect(stellaHarnessPid(11, "linux", lookup)).toBe(501);
    expect(stellaHarnessPid(14, "linux", lookup)).toBe(503);
    // A shell whose parent is init is not under Stella: keep the shell.
    expect(stellaHarnessPid(12, "linux", lookup)).toBe(12);
    // bash exec'd the hook: the parent is Stella itself.
    expect(stellaHarnessPid(13, "darwin", lookup)).toBe(13);
    // ps knows nothing: the parent is the best answer.
    expect(stellaHarnessPid(99, "darwin", lookup)).toBe(99);
    // Windows has no ps: the parent, without a lookup.
    lookups.length = 0;
    expect(stellaHarnessPid(10, "win32", lookup)).toBe(10);
    expect(lookups).toEqual([]);
  });
});

describe("stella payload", () => {
  it("translates tool events into Claude Code's shape and pairs Pre with Post", () => {
    const pre = translateStellaPayload(
      {
        event: "PreToolUse",
        cwd: "/repo",
        tool: { name: "bash", input: { command: "ls" }, read_only: false },
      },
      4242,
    );
    const post = translateStellaPayload(
      {
        event: "PostToolUse",
        cwd: "/repo",
        tool: { name: "bash", input: { command: "ls" }, read_only: false },
        toolResult: "a\nb",
      },
      4242,
    );
    const id = stellaToolUseId("bash", { command: "ls" });
    expect(id).toMatch(/^stella_[0-9a-f]{24}$/);
    expect(stellaToolUseId("bash", { command: "pwd" })).not.toBe(id);
    expect(pre).toEqual({
      session_id: stellaSessionId(4242),
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "bash",
      tool_input: { command: "ls" },
      tool_use_id: id,
      tool_read_only: false,
    });
    expect(post).toMatchObject({
      session_id: "stella-4242",
      hook_event_name: "PostToolUse",
      tool_use_id: id,
      tool_response: "a\nb",
    });
    expect(post).not.toHaveProperty("toolResult");
    expect(hookInputSchema.safeParse(pre).success).toBe(true);
    expect(hookInputSchema.safeParse(post).success).toBe(true);
    // A tool whose input is not an object still has an object tool_input.
    expect(
      translateStellaPayload(
        { event: "PreToolUse", cwd: "/", tool: { name: "echo", input: "hi" } },
        1,
      ),
    ).toMatchObject({ tool_input: { value: "hi" } });
    expect(
      translateStellaPayload(
        { event: "PreToolUse", cwd: "/", tool: { input: {} } },
        1,
      ),
    ).not.toHaveProperty("tool_name");
  });

  it("renames Stop, prompt and subagent members and passes every other member through", () => {
    expect(
      translateStellaPayload(
        { event: "Stop", cwd: "/repo", finalText: "done" },
        7,
      ),
    ).toEqual({
      session_id: "stella-7",
      hook_event_name: "Stop",
      cwd: "/repo",
      last_assistant_message: "done",
    });
    expect(
      translateStellaPayload(
        { event: "UserPromptSubmit", cwd: "/repo", prompt: "hi" },
        7,
      ),
    ).toMatchObject({ prompt: "hi", hook_event_name: "UserPromptSubmit" });
    const subagent = {
      agentId: "child-1",
      instructionPreview: "look",
      depth: 1,
    };
    expect(
      translateStellaPayload(
        {
          event: "SubagentStop",
          cwd: "/repo",
          subagent,
          subagentResult: { clean: true },
          issue: { number: 3 },
          reason: "finished",
        },
        7,
      ),
    ).toEqual({
      session_id: "stella-7",
      hook_event_name: "SubagentStop",
      cwd: "/repo",
      subagent,
      agent_id: "child-1",
      subagent_result: { clean: true },
      issue: { number: 3 },
      reason: "finished",
    });
    // Not a Stella payload: returned as is, for the schema to refuse.
    const junk = { hook_event_name: "Stop" };
    expect(translateStellaPayload(junk, 7)).toBe(junk);
    expect(translateStellaPayload([1], 7)).toEqual([1]);
    expect(translateStellaPayload(null, 7)).toBeNull();
  });
});

describe("stella answer", () => {
  const pre = (decision: string, reason?: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason !== undefined ? { permissionDecisionReason: reason } : {}),
    },
  });

  it("maps each Claude Code answer onto Stella's decision vocabulary", () => {
    expect(stellaAnswer(pre("deny", "no push"), "PreToolUse")).toBe(
      '{"action":"deny","reason":"no push"}\n',
    );
    expect(stellaAnswer(pre("deny"), "PreToolUse")).toBe(
      '{"action":"deny","reason":"Denied by Oxagen policy."}\n',
    );
    expect(stellaAnswer(pre("ask", "rm needs a human"), "PreToolUse")).toBe(
      '{"action":"require_approval","reason":"rm needs a human"}\n',
    );
    expect(stellaAnswer(pre("ask"), "PreToolUse")).toContain(
      "asks for approval",
    );
    expect(stellaAnswer(pre("allow", "listed"), "PreToolUse")).toBe(
      '{"action":"allow"}\n',
    );
    expect(
      stellaAnswer(
        { decision: "block", reason: "session paused" },
        "UserPromptSubmit",
      ),
    ).toBe('{"action":"deny","reason":"session paused"}\n');
    expect(stellaAnswer({ decision: "block" }, "UserPromptSubmit")).toContain(
      "Blocked by Oxagen policy.",
    );
    // SessionStart is no veto point and its stdout is prompt text: a block
    // is explained in prose, never printed as a decision.
    expect(
      stellaAnswer(
        {
          continue: false,
          stopReason: "This host is suspended by its Oxagen operator.",
        },
        "SessionStart",
      ),
    ).toBe(
      "Oxagen: This host is suspended by its Oxagen operator. Tool calls will be refused.\n",
    );
    expect(stellaAnswer({ continue: false }, "SessionStart")).toBe(
      "Oxagen: This session is stopped by its Oxagen operator. Tool calls will be refused.\n",
    );
    expect(stellaAnswer({ continue: false }, "SessionStart")).not.toContain(
      "action",
    );
    // Anywhere Stella does read decisions, a stop is still a deny.
    expect(
      stellaAnswer({ continue: false, stopReason: "stop" }, "PostToolUse"),
    ).toBe('{"action":"deny","reason":"stop"}\n');
    expect(stellaAnswer({ continue: false }, "PostToolUse")).toContain(
      "Stopped by Oxagen policy.",
    );
  });

  it("never fails open when an answer carries two decisions: deny > ask > stop > allow", () => {
    const allow = { permissionDecision: "allow" };
    expect(
      stellaAnswer(
        { continue: false, hookSpecificOutput: allow },
        "PreToolUse",
      ),
    ).toBe('{"action":"deny","reason":"Stopped by Oxagen policy."}\n');
    expect(
      stellaAnswer(
        { decision: "block", reason: "paused", hookSpecificOutput: allow },
        "UserPromptSubmit",
      ),
    ).toBe('{"action":"deny","reason":"paused"}\n');
    expect(
      stellaAnswer(
        {
          continue: false,
          stopReason: "stop",
          hookSpecificOutput: {
            permissionDecision: "ask",
            permissionDecisionReason: "a human decides",
          },
        },
        "PreToolUse",
      ),
    ).toBe('{"action":"require_approval","reason":"a human decides"}\n');
    expect(
      stellaAnswer(
        {
          continue: false,
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "no",
          },
        },
        "PreToolUse",
      ),
    ).toBe('{"action":"deny","reason":"no"}\n');
    // On SessionStart a stop outranks both an allow and bundle context.
    expect(
      stellaAnswer(
        {
          continue: false,
          stopReason: "Host revoked.",
          hookSpecificOutput: { ...allow, additionalContext: "ctx" },
        },
        "SessionStart",
      ),
    ).toBe("Oxagen: Host revoked. Tool calls will be refused.\n");
    expect(stellaAnswer({ decision: "block" }, "SessionStart")).toBe(
      "Oxagen: This session is stopped by its Oxagen operator. Tool calls will be refused.\n",
    );
  });

  it("answers context as SessionStart text and nothing else as {}", () => {
    expect(
      stellaAnswer(
        {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "You are governed by Oxagen.",
          },
        },
        "SessionStart",
      ),
    ).toBe("You are governed by Oxagen.\n");
    // SessionStart stdout becomes prompt text: no JSON, no `{}`.
    expect(stellaAnswer({}, "SessionStart")).toBe("");
    expect(stellaAnswer({ hookSpecificOutput: "junk" }, "SessionStart")).toBe(
      "",
    );
    // Operator messages on UserPromptSubmit have no Stella channel.
    expect(
      stellaAnswer(
        { hookSpecificOutput: { additionalContext: "note" } },
        "UserPromptSubmit",
      ),
    ).toBe("{}\n");
    expect(stellaAnswer({}, "PostToolUse")).toBe("{}\n");
  });

  it("parses a daemon body, treating anything but a JSON object as no answer", () => {
    expect(parseAnswerBody('{"decision":"block"}')).toEqual({
      decision: "block",
    });
    expect(parseAnswerBody("")).toEqual({});
    expect(parseAnswerBody("not json")).toEqual({});
    expect(parseAnswerBody("[1,2]")).toEqual({});
  });
});
