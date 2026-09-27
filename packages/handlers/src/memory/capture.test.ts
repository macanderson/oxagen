import { describe, expect, it } from "vitest";
import {
  captureRun,
  FAILED_STATUSES,
  frameRef,
  lessonMemories,
  memoryToolOf,
  serverToolFeedback,
  serverToolGrades,
  serverToolName,
  withoutMcpPrefix,
  type MemoryToolCall,
} from "./capture";
import { statementHash } from "./statement";
import type { ReflectionDraft } from "./types";

const RUN = "arun_01K5QK7D";
const AGENT = "a-intel.core.release-bot";

function call(
  seq: string,
  tool: string,
  input: unknown,
  status: string | null = "completed",
): MemoryToolCall {
  return { seq, tool, status, input };
}

function capture(calls: MemoryToolCall[], agentLineage: string | null = AGENT) {
  return captureRun({ runPublicId: RUN, agentLineage, calls });
}

const REFLECTION = {
  outcome: "completed",
  summary: "Bumped the lockfile and fixed the CI cache key.",
  grades: { work: 4, tools: { mcp__github__create_pr: 5, Bash: 3 } },
  lessons: [],
};

describe("memoryToolOf", () => {
  it("reads the bare names", () => {
    expect(memoryToolOf("remember_lesson")).toBe("remember_lesson");
    expect(memoryToolOf("record_reflection")).toBe("record_reflection");
  });

  it("reads the name after the last __, dot, or slash", () => {
    expect(memoryToolOf("mcp__oxagen__remember_lesson")).toBe("remember_lesson");
    expect(memoryToolOf("oxagen__record_reflection")).toBe("record_reflection");
    expect(memoryToolOf("oxagen.remember_lesson")).toBe("remember_lesson");
    expect(memoryToolOf("oxagen/record_reflection")).toBe("record_reflection");
  });

  it("refuses a name that only contains a memory tool's name", () => {
    expect(memoryToolOf("not_remember_lesson")).toBeNull();
    expect(memoryToolOf("remember_lessons")).toBeNull();
    expect(memoryToolOf("Bash")).toBeNull();
    expect(memoryToolOf("")).toBeNull();
  });
});

describe("frameRef", () => {
  it("names one frame of a run", () => {
    expect(frameRef(RUN, "88")).toBe("frame:arun_01K5QK7D/88");
  });
});

describe("FAILED_STATUSES", () => {
  it("copies the run ledger's failed outcomes", () => {
    expect([...FAILED_STATUSES].sort()).toEqual(
      ["cancelled", "denied", "error", "failed", "refused", "rejected", "timeout"],
    );
  });
});

describe("withoutMcpPrefix", () => {
  it("drops the prefix from mcp__<server>__<tool>", () => {
    expect(withoutMcpPrefix("mcp__billing__create_refund")).toBe(
      "billing__create_refund",
    );
    expect(withoutMcpPrefix("mcp__billing__*")).toBe("billing__*");
  });

  it("keeps a name with no prefix to drop", () => {
    expect(withoutMcpPrefix("mcp__query")).toBe("mcp__query");
    expect(withoutMcpPrefix("billing__create_refund")).toBe(
      "billing__create_refund",
    );
    expect(withoutMcpPrefix("Bash")).toBe("Bash");
  });
});

describe("serverToolName", () => {
  it("drops Claude Code's mcp__ prefix", () => {
    expect(serverToolName("mcp__billing__create_refund")).toBe(
      "billing__create_refund",
    );
  });

  it("keeps a name that is already <server>__<tool>", () => {
    expect(serverToolName("billing__create_refund")).toBe("billing__create_refund");
  });

  it("reads mcp__<tool> as a tool of a server named mcp", () => {
    expect(serverToolName("mcp__query")).toBe("mcp__query");
  });

  it("drops a tool with no server owner", () => {
    expect(serverToolName("Bash")).toBeNull();
    expect(serverToolName("builtin__bash")).toBeNull();
    expect(serverToolName("mcp__builtin__bash")).toBeNull();
  });

  it("drops a name that is not a tool name", () => {
    expect(serverToolName("mcp__claude-in-chrome__navigate")).toBeNull();
    expect(serverToolName("Billing__Create_Refund")).toBeNull();
    expect(serverToolName("billing__create_refund@3")).toBeNull();
  });
});

describe("serverToolGrades", () => {
  it("keys each grade by <server>__<tool> and drops built-in tools", () => {
    expect(
      serverToolGrades({
        mcp__billing__create_refund: 2,
        Read: 5,
        github__create_pr: 4,
      }),
    ).toEqual({ billing__create_refund: 2, github__create_pr: 4 });
  });

  it("keeps the first grade when two names map to one tool", () => {
    expect(
      serverToolGrades({ mcp__billing__create_refund: 2, billing__create_refund: 5 }),
    ).toEqual({ billing__create_refund: 2 });
  });
});

describe("serverToolFeedback", () => {
  it("maps each tool and drops built-in tools", () => {
    expect(
      serverToolFeedback([
        { tool: "mcp__billing__create_refund", problem: "The amount is in cents." },
        { tool: "Bash", problem: "Too slow." },
        { tool: "billing__create_refund", problem: "No idempotency key." },
      ]),
    ).toEqual([
      { tool: "billing__create_refund", problem: "The amount is in cents." },
      { tool: "billing__create_refund", problem: "No idempotency key." },
    ]);
  });
});

describe("captureRun: remember_lesson", () => {
  it("turns a call into a memory with the run's agent and run", () => {
    const statement = "Update pnpm-lock.yaml with every dependency change.";
    const { memories, reflection } = capture([
      call("90", "mcp__oxagen__remember_lesson", {
        statement: `  ${statement}  `,
        kind: "code-rule",
        repos: ["github.com/a-intel/platform"],
        applies_to: ["pnpm-lock.yaml"],
        tools: ["github__create_pr"],
        evidence: [88, 88, 89],
      }),
    ]);
    expect(reflection).toBeNull();
    expect(memories).toEqual([
      {
        agentLineage: AGENT,
        runPublicId: RUN,
        capture: "remember",
        statement,
        statementHash: statementHash(statement),
        kind: "code-rule",
        repos: ["github.com/a-intel/platform"],
        appliesTo: ["pnpm-lock.yaml"],
        tools: ["github__create_pr"],
        evidence: ["frame:arun_01K5QK7D/88", "frame:arun_01K5QK7D/89"],
        source: null,
        dedupeKey: `${RUN}:${statementHash(statement)}`,
      },
    ]);
  });

  it("defaults the kind to memory, the targets to null, and the evidence to the call's own frame", () => {
    const { memories } = capture([
      call("12", "remember_lesson", { statement: "Run the generator first." }),
    ]);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      kind: "memory",
      repos: null,
      appliesTo: null,
      tools: null,
      evidence: ["frame:arun_01K5QK7D/12"],
    });
  });

  it("keeps a null agent as null", () => {
    const { memories } = capture(
      [call("3", "remember_lesson", { statement: "Pin the node version." })],
      null,
    );
    expect(memories[0]?.agentLineage).toBeNull();
  });

  it("skips a call that failed or that Oxagen denied", () => {
    const calls = [...FAILED_STATUSES].map((status, i) =>
      call(String(i), "remember_lesson", { statement: `Lesson ${i}.` }, status),
    );
    expect(capture(calls).memories).toEqual([]);
  });

  it("keeps a call whose frame records no status", () => {
    const { memories } = capture([
      call("4", "remember_lesson", { statement: "Read the ADR first." }, null),
    ]);
    expect(memories).toHaveLength(1);
  });

  it("skips an input the contract refuses", () => {
    const { memories } = capture([
      call("1", "remember_lesson", {}),
      call("2", "remember_lesson", { statement: "   " }),
      call("3", "remember_lesson", "Run the tests."),
      call("4", "remember_lesson", { statement: "Use pnpm.", evidence: [-1] }),
      // The agent and run come from the run record, so input that names them is refused.
      call("5", "remember_lesson", { statement: "Use pnpm.", agent: "someone-else" }),
    ]);
    expect(memories).toEqual([]);
  });

  it("ignores every other tool", () => {
    expect(
      capture([call("1", "Bash", { statement: "Run the tests." })]),
    ).toEqual({ memories: [], reflection: null });
  });

  it("drops a repeated statement and keeps the first", () => {
    const { memories } = capture([
      call("1", "remember_lesson", { statement: "Run the tests." }),
      call("2", "remember_lesson", { statement: "run the TESTS" }),
      call("3", "remember_lesson", { statement: "Lint the diff." }),
    ]);
    expect(memories.map((memory) => memory.statement)).toEqual([
      "Run the tests.",
      "Lint the diff.",
    ]);
    expect(memories[0]?.evidence).toEqual(["frame:arun_01K5QK7D/1"]);
  });
});

describe("captureRun: record_reflection", () => {
  it("maps the reflection and keys tool grades by <server>__<tool>", () => {
    const { reflection } = capture([
      call("40", "mcp__oxagen__record_reflection", {
        ...REFLECTION,
        tool_feedback: [
          { tool: "mcp__github__create_pr", problem: "The draft flag is missing." },
          { tool: "Bash", problem: "Too slow." },
        ],
      }),
    ]);
    expect(reflection).toEqual({
      runPublicId: RUN,
      agentLineage: AGENT,
      source: "agent",
      outcome: "completed",
      summary: "Bumped the lockfile and fixed the CI cache key.",
      grades: { work: 4, tools: { github__create_pr: 5 } },
      lessons: [],
      toolFeedback: [
        { tool: "github__create_pr", problem: "The draft flag is missing." },
      ],
    });
  });

  it("gives no tool feedback when the input names none", () => {
    const { reflection } = capture([call("40", "record_reflection", REFLECTION)]);
    expect(reflection?.toolFeedback).toEqual([]);
  });

  it("turns each lesson into a memory, citing the reflection's frame when the lesson cites none", () => {
    const { memories, reflection } = capture([
      call("40", "record_reflection", {
        ...REFLECTION,
        lessons: [
          { statement: "Key the CI cache on the lockfile.", evidence: [38] },
          { statement: "Run the generator first.", kind: "procedure" },
        ],
      }),
    ]);
    expect(reflection?.lessons).toEqual([
      expect.objectContaining({
        statement: "Key the CI cache on the lockfile.",
        kind: "memory",
        evidence: ["frame:arun_01K5QK7D/38"],
      }),
      expect.objectContaining({
        statement: "Run the generator first.",
        kind: "procedure",
        evidence: ["frame:arun_01K5QK7D/40"],
      }),
    ]);
    expect(memories.map((memory) => [memory.statement, memory.evidence])).toEqual([
      ["Key the CI cache on the lockfile.", ["frame:arun_01K5QK7D/38"]],
      ["Run the generator first.", ["frame:arun_01K5QK7D/40"]],
    ]);
    expect(memories.every((memory) => memory.capture === "remember")).toBe(true);
  });

  it("takes the last valid reflection, and only its lessons become memories", () => {
    const { memories, reflection } = capture([
      call("10", "record_reflection", {
        ...REFLECTION,
        summary: "First try.",
        lessons: [{ statement: "An early lesson." }],
      }),
      call("20", "record_reflection", {
        ...REFLECTION,
        summary: "Second try.",
        lessons: [{ statement: "A later lesson." }],
      }),
      call("30", "record_reflection", { ...REFLECTION, outcome: "running" }),
      call(
        "35",
        "record_reflection",
        { ...REFLECTION, summary: "Denied." },
        "denied",
      ),
    ]);
    expect(reflection?.summary).toBe("Second try.");
    expect(memories.map((memory) => memory.statement)).toEqual(["A later lesson."]);
  });

  it("orders memories by call, and a lesson the run already remembered keeps the first copy", () => {
    const { memories } = capture([
      call("3", "remember_lesson", { statement: "Run the tests." }),
      call("5", "record_reflection", {
        ...REFLECTION,
        lessons: [
          { statement: "Pin the node version." },
          { statement: "Run the tests!" },
        ],
      }),
      call("8", "remember_lesson", { statement: "Lint the diff." }),
    ]);
    expect(memories.map((memory) => [memory.statement, memory.evidence[0]])).toEqual([
      ["Run the tests.", "frame:arun_01K5QK7D/3"],
      ["Pin the node version.", "frame:arun_01K5QK7D/5"],
      ["Lint the diff.", "frame:arun_01K5QK7D/8"],
    ]);
  });
});

describe("lessonMemories", () => {
  it("turns a reflection's lessons into memories with its agent and run", () => {
    const reflection: ReflectionDraft = {
      runPublicId: "tse_01K5",
      agentLineage: null,
      source: "digest",
      outcome: "failed",
      summary: "The run failed.",
      grades: { work: 2, tools: {} },
      lessons: [
        {
          statement: "Check the token scope first.",
          kind: "fact",
          repos: ["github.com/a-intel/platform"],
          evidence: ["frame:tse_01K5/7"],
        },
      ],
      toolFeedback: [],
    };
    expect(lessonMemories(reflection)).toEqual([
      {
        agentLineage: null,
        runPublicId: "tse_01K5",
        capture: "remember",
        statement: "Check the token scope first.",
        statementHash: statementHash("Check the token scope first."),
        kind: "fact",
        repos: ["github.com/a-intel/platform"],
        appliesTo: null,
        tools: null,
        evidence: ["frame:tse_01K5/7"],
        source: null,
        dedupeKey: `tse_01K5:${statementHash("Check the token scope first.")}`,
      },
    ]);
  });
});
