/**
 * The reflection ask (`reflection-ask.ts`): which hooks count as signs of
 * trouble, and when the Stop's ask is written. The tests import through the
 * package barrel, so its exports are covered with the module.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../../claude-code/context";
import { TEST_ENROLLMENT } from "../../host/test-support";
import { type SessionRecord, SessionRegistry } from "../registry";
import {
  isCorrectionPrompt,
  notePolicyDenial,
  notePrompt,
  noteToolCall,
  noteToolFailure,
  REFLECTION_ASK_MAX_CHARS,
  REFLECTION_TOOL_NAME,
  RETRY_LOOP_LENGTH,
  type ReflectionAskOptions,
  reflectionAsk,
} from "./index";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const STOP: ReflectionAskOptions = {
  harness: "claude-code",
  stopHookActive: false,
  replayed: false,
  toolRegistered: () => true,
};

let sessions = 0;

/** A new session's record, so each test starts with no reflection state. */
function freshRecord(): SessionRecord {
  let clock = Date.parse("2026-09-10T10:00:00.000Z");
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now: () => (clock += 1000),
  });
  sessions += 1;
  return registry.ensure(`sess-reflect-${sessions}`).record;
}

/** The ask a Claude Code Stop would carry, failing the test when there is none. */
function askOf(record: SessionRecord): string {
  const ask = reflectionAsk(record, STOP);
  if (ask === undefined) throw new Error("expected an ask");
  return ask;
}

describe("the signals", () => {
  it("counts a failed tool call and names the tool", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    expect(askOf(record)).toMatch(/^This run had a failed tool call \(Bash\)\./);
  });

  it("counts a policy denial and names the tool", () => {
    const record = freshRecord();
    notePolicyDenial(record, "Bash");
    expect(askOf(record)).toMatch(
      /^This run had a call the policy denied \(Bash\)\./,
    );
  });

  it("counts a retry loop at the third identical call", () => {
    const record = freshRecord();
    for (let call = 0; call < RETRY_LOOP_LENGTH; call += 1)
      noteToolCall(record, "Bash", { command: "npm test" });
    expect(askOf(record)).toMatch(
      /^This run had a call repeated 3 times in a row \(Bash\)\./,
    );
  });

  it("counts a later prompt that opens with a correction", () => {
    const record = freshRecord();
    notePrompt(record, "Add a README.");
    notePrompt(record, "No, put it in docs/.");
    expect(askOf(record)).toMatch(
      /^This run had a prompt that corrected you\./,
    );
  });

  it("counts a failure with no tool name and names none", () => {
    const record = freshRecord();
    noteToolFailure(record, undefined);
    notePolicyDenial(record, "");
    expect(askOf(record)).toMatch(
      /^This run had a failed tool call and a call the policy denied\./,
    );
  });

  it("lists every kind in order, with counts and at most three tools each", () => {
    const record = freshRecord();
    notePrompt(record, "Fix the build.");
    notePrompt(record, "Actually, leave the lockfile alone.");
    notePrompt(record, "Don’t touch CI either.");
    for (const tool of ["Bash", "Read", "Bash", "Edit", "Write", "Grep"])
      noteToolFailure(record, tool);
    for (let call = 0; call < RETRY_LOOP_LENGTH; call += 1)
      noteToolCall(record, "Read", { file_path: "/a" });
    notePolicyDenial(record, "Bash");
    expect(askOf(record)).toMatch(
      /^This run had 6 failed tool calls \(Bash, Read, Edit\), a call the policy denied \(Bash\), a call repeated 3 times in a row \(Read\), and 2 prompts that corrected you\./,
    );
  });
});

describe("the retry loop", () => {
  it("counts once for a run, and again after a different call ends the run", () => {
    const record = freshRecord();
    for (let call = 0; call < 5; call += 1)
      noteToolCall(record, "Bash", { command: "npm test" });
    noteToolCall(record, "Read", { file_path: "/a" });
    for (let call = 0; call < RETRY_LOOP_LENGTH; call += 1)
      noteToolCall(record, "Bash", { command: "npm test" });
    expect(askOf(record)).toMatch(
      /^This run had 2 calls repeated 3 times in a row \(Bash\)\./,
    );
  });

  it("does not count two identical calls, or a run a different call breaks", () => {
    const record = freshRecord();
    noteToolCall(record, "Bash", { command: "ls" });
    noteToolCall(record, "Bash", { command: "ls" });
    noteToolCall(record, "Bash", { command: "pwd" });
    noteToolCall(record, "Bash", { command: "ls" });
    noteToolCall(record, "Read", { command: "ls" });
    noteToolCall(record, "Bash", { command: "ls" });
    expect(reflectionAsk(record, STOP)).toBeUndefined();
  });

  it("treats the same input in another key order as the same call", () => {
    const record = freshRecord();
    noteToolCall(record, "Grep", { pattern: "x", path: "/src" });
    noteToolCall(record, "Grep", { path: "/src", pattern: "x" });
    noteToolCall(record, "Grep", { pattern: "x", path: "/src" });
    expect(askOf(record)).toContain("a call repeated 3 times in a row (Grep)");
  });

  it("counts calls with no input by tool name alone", () => {
    const record = freshRecord();
    for (let call = 0; call < RETRY_LOOP_LENGTH; call += 1)
      noteToolCall(record, "TodoRead", undefined);
    expect(askOf(record)).toContain("(TodoRead)");
  });

  it("ends the run at a call whose input has no JCS text", () => {
    const record = freshRecord();
    noteToolCall(record, "Bash", { command: "ls" });
    noteToolCall(record, "Bash", { command: "ls" });
    noteToolCall(record, "Bash", { size: 10n });
    noteToolCall(record, "Bash", { command: "ls" });
    noteToolCall(record, "Bash", { command: "ls" });
    expect(reflectionAsk(record, STOP)).toBeUndefined();
  });
});

describe("a correction", () => {
  it("never counts the first prompt of a session", () => {
    const record = freshRecord();
    notePrompt(record, "No, start over.");
    expect(reflectionAsk(record, STOP)).toBeUndefined();
  });

  it("counts a later prompt only when it opens with a correction", () => {
    const record = freshRecord();
    notePrompt(record, "Write the migration.");
    notePrompt(record, "now run the tests");
    notePrompt(record, "notice the log");
    notePrompt(record, undefined);
    expect(reflectionAsk(record, STOP)).toBeUndefined();
  });

  it("matches an opener only as whole words", () => {
    for (const prompt of [
      "no",
      "No.",
      "  nope, try again",
      "Wrong file",
      "That's wrong",
      "That’s wrong",
      "Actually, use pnpm",
      "don't push",
      "Do not merge",
      "Stop!",
      "instead: use the flag",
      "You forgot the test",
      "undo that",
      "Revert it",
    ])
      expect(isCorrectionPrompt(prompt)).toBe(true);
    for (const prompt of [
      "now run the tests",
      "notice the log",
      "nothing else",
      "stopwatch the build",
      "wrongly named, fix it",
      "donuts",
      "undone work remains",
      "no's are fine",
      "please undo that",
      "",
    ])
      expect(isCorrectionPrompt(prompt)).toBe(false);
  });
});

describe("the ask", () => {
  it("asks only a Claude Code session", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    expect(
      reflectionAsk(record, { ...STOP, harness: "codex" }),
    ).toBeUndefined();
    expect(
      reflectionAsk(record, { ...STOP, harness: "cursor" }),
    ).toBeUndefined();
    expect(
      reflectionAsk(record, { ...STOP, harness: undefined }),
    ).toBeUndefined();
    // A refused Stop does not use up the one ask.
    expect(reflectionAsk(record, STOP)).toBeDefined();
  });

  it("does not ask at a Stop that follows a block, or at a replay", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    expect(
      reflectionAsk(record, { ...STOP, stopHookActive: true }),
    ).toBeUndefined();
    expect(reflectionAsk(record, { ...STOP, replayed: true })).toBeUndefined();
    expect(reflectionAsk(record, STOP)).toBeDefined();
  });

  it("does not ask when the session cannot reach the tool, and keeps the ask for later (#5287)", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    let checks = 0;
    const unregistered = () => {
      checks += 1;
      return false;
    };
    expect(
      reflectionAsk(record, { ...STOP, toolRegistered: unregistered }),
    ).toBeUndefined();
    expect(checks).toBe(1);
    // A Stop that found no tool did not use up the one ask.
    expect(reflectionAsk(record, STOP)).toBeDefined();
  });

  it("checks for the tool only after every cheaper check passes", () => {
    let checks = 0;
    const counted = { ...STOP, toolRegistered: () => (checks += 1) > 0 };
    // No signal, a Stop after a block, a replay, and another harness.
    expect(reflectionAsk(freshRecord(), counted)).toBeUndefined();
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    expect(
      reflectionAsk(record, { ...counted, stopHookActive: true }),
    ).toBeUndefined();
    expect(reflectionAsk(record, { ...counted, replayed: true })).toBeUndefined();
    expect(
      reflectionAsk(record, { ...counted, harness: "codex" }),
    ).toBeUndefined();
    expect(checks).toBe(0);
    expect(reflectionAsk(record, counted)).toBeDefined();
    expect(checks).toBe(1);
  });

  it("does not ask a run with no signal", () => {
    expect(reflectionAsk(freshRecord(), STOP)).toBeUndefined();
    const quiet = freshRecord();
    notePrompt(quiet, "Add a README.");
    noteToolCall(quiet, "Read", { file_path: "/README.md" });
    expect(reflectionAsk(quiet, STOP)).toBeUndefined();
  });

  it("does not ask an agent that already called record_reflection", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    noteToolCall(record, REFLECTION_TOOL_NAME, { outcome: "failed" });
    expect(reflectionAsk(record, STOP)).toBeUndefined();
    const bare = freshRecord();
    noteToolFailure(bare, "Bash");
    noteToolCall(bare, "record_reflection", undefined);
    expect(reflectionAsk(bare, STOP)).toBeUndefined();
  });

  it("asks once per session", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    expect(reflectionAsk(record, STOP)).toBeDefined();
    noteToolFailure(record, "Read");
    expect(reflectionAsk(record, STOP)).toBeUndefined();
  });

  it("names the reflection tool and tells the agent when to skip it", () => {
    const record = freshRecord();
    noteToolFailure(record, "Bash");
    const ask = askOf(record);
    expect(REFLECTION_TOOL_NAME).toBe("mcp__oxagen__record_reflection");
    expect(ask).toContain(`call ${REFLECTION_TOOL_NAME} once`);
    expect(ask).toContain("Skip the call only if the tool is not available.");
    expect(ask.length).toBeLessThanOrEqual(REFLECTION_ASK_MAX_CHARS);
  });

  it("clips a long tool name", () => {
    const record = freshRecord();
    const long = `mcp__server__${"t".repeat(100)}`;
    noteToolFailure(record, long);
    const ask = askOf(record);
    expect(ask).not.toContain(long);
    expect(ask).toContain(`(${long.slice(0, 61)}...)`);
  });

  it("stays within the cap with many long tool names, and still names the tool", () => {
    const record = freshRecord();
    notePrompt(record, "Fix the build.");
    for (let prompt = 0; prompt < 4; prompt += 1)
      notePrompt(record, "No, not that way.");
    for (let tool = 0; tool < 8; tool += 1) {
      const name = `mcp__server_${tool}__${"x".repeat(200)}`;
      noteToolFailure(record, name);
      notePolicyDenial(record, name);
      for (let call = 0; call < RETRY_LOOP_LENGTH; call += 1)
        noteToolCall(record, name, { tool });
    }
    const ask = askOf(record);
    expect(ask.length).toBeLessThanOrEqual(REFLECTION_ASK_MAX_CHARS);
    expect(ask).toContain(REFLECTION_TOOL_NAME);
    expect(ask).toMatch(
      /^This run had 8 failed tool calls, 8 calls the policy denied, 8 calls repeated 3 times in a row, and 4 prompts that corrected you\./,
    );
  });
});
