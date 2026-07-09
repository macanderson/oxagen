/**
 * prompt-intent — the zero-cost heuristic that routes conversational/lookup
 * turns onto the fast path (skip planner + judge). The classifier is
 * deliberately conservative toward "task": these tests pin BOTH that real
 * lookups get the fast path (the motivating "what's the command to add an MCP
 * server" case) AND that genuine coding tasks never do.
 */
import { describe, it, expect } from "vitest";
import { classifyPromptIntent } from "../prompt-intent.js";

describe("classifyPromptIntent", () => {
  describe("simple (fast path)", () => {
    const lookups = [
      // The motivating case: interrogative lead wins over the "add" inside it.
      "what is the command to add an MCP server using oxagen cli",
      "what's the flag to enable verbose mode?",
      "how do I add a knowledge source?",
      "how does the metering loop work",
      "where is the chat route defined?",
      "which model does the planner use",
      "why is the judge running on Fable?",
      "when does the code graph rebuild",
      "who owns the billing contract",
      "is there a command to list connections?",
      "can the CLI run offline?",
      "does oxagen support BYOK?",
      "the mcp add command?",
      "what is the command to add mcp server\n\ni want to add @modelcontextprotocol/server-filesystem",
    ];
    for (const prompt of lookups) {
      it(`treats as simple: ${prompt.slice(0, 48)}`, () => {
        expect(classifyPromptIntent(prompt)).toBe("simple");
      });
    }
  });

  describe("task (full pipeline)", () => {
    const tasks = [
      // Imperative leads — real work.
      "add the filesystem MCP to my config",
      "create a new connector for GitHub",
      "fix the RLS fail-open bug in the tenant guard",
      "implement the eval.run contract",
      "refactor the model router to drop the duplicate classifier",
      "write a test for the fast path",
      "update the docs for mcp add",
      "migrate the fact edges to bi-temporal validity",
      // Delegation flips a question-shaped prompt back to a task.
      "can you add the filesystem MCP for me?",
      "could you implement the fast path?",
      "would you fix this and push it",
      "please add an API route for connections",
      // Ambiguous / statement fragments stay tasks.
      "the tenant guard is fail-open",
      "make it faster",
    ];
    for (const prompt of tasks) {
      it(`treats as task: ${prompt.slice(0, 48)}`, () => {
        expect(classifyPromptIntent(prompt)).toBe("task");
      });
    }
  });

  it("empty / whitespace prompt is a task (never fast-paths a no-op)", () => {
    expect(classifyPromptIntent("")).toBe("task");
    expect(classifyPromptIntent("   \n  ")).toBe("task");
  });

  it("classifies off the first line of a multi-line paste", () => {
    // Opening clause is a question; the trailing log dump must not flip it.
    expect(
      classifyPromptIntent("what's the error here?\n\nError: FUNCTION_INVOCATION_FAILED\n  at foo (bar.ts:1)"),
    ).toBe("simple");
    // Opening clause is imperative; still a task despite a trailing "?".
    expect(
      classifyPromptIntent("fix this stack trace\n\nis it the null deref?"),
    ).toBe("task");
  });
});
