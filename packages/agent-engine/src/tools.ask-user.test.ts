/**
 * ask_user — the interactive clarification tool.
 *
 * Registered ONLY when an `askUser` callback is supplied (an interactive surface
 * with a human to answer). It validates the
 * question + option set, forwards the user's reply to the model as plain text
 * (prefixed to say whether they chose an option or wrote their own), and returns
 * a corrective error STRING (never throws — the loop stays alive) on bad input.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
import type { AskUserResponse } from "./types";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (
    tool as { execute: (i: unknown, o: unknown) => Promise<string> }
  ).execute(input, {});
}

const chose = (answer: string) => async (): Promise<AskUserResponse> => ({
  answer,
  wasFreeText: false,
});

describe("ask_user tool registration (gating)", () => {
  it("is absent without an askUser callback", () => {
    const ws = new MemoryWorkspace({});
    expect(buildWorkspaceTools(ws).ask_user).toBeUndefined();
  });

  it("is present when an askUser callback is supplied", () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, { askUser: chose("A") });
    expect(tools.ask_user).toBeDefined();
  });

  it("stays available in readOnly mode — asking a question mutates nothing", () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, {
      readOnly: true,
      askUser: chose("A"),
    });
    expect(tools.ask_user).toBeDefined();
    // The mutating tools are still withheld — ask_user is not one of them.
    expect(tools.write_file).toBeUndefined();
    expect(tools.bash).toBeUndefined();
  });
});

describe("ask_user callback round-trip", () => {
  it("prefixes a chosen option with [user chose]", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, {
      askUser: async () => ({ answer: "Postgres", wasFreeText: false }),
    });
    const out = await run(tools.ask_user, {
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    expect(out).toBe("[user chose] Postgres");
  });

  it("prefixes a typed answer with [user wrote]", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, {
      askUser: async () => ({ answer: "use MySQL", wasFreeText: true }),
    });
    const out = await run(tools.ask_user, {
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    expect(out).toBe("[user wrote] use MySQL");
  });

  it("passes the trimmed question and de-duped options to the callback", async () => {
    const ws = new MemoryWorkspace({});
    let seen: { question: string; options: string[] } | null = null;
    const tools = buildWorkspaceTools(ws, {
      askUser: async (q) => {
        seen = q;
        return { answer: q.options[0] ?? "", wasFreeText: false };
      },
    });
    await run(tools.ask_user, {
      question: "  Which one?  ",
      options: ["A", "a", "B", ""],
    });
    expect(seen).not.toBeNull();
    expect(seen!.question).toBe("Which one?");
    // "a" is a case-insensitive dupe of "A"; the blank is dropped.
    expect(seen!.options).toEqual(["A", "B"]);
  });
});

describe("ask_user validation (returns an error string, never throws)", () => {
  const ws = new MemoryWorkspace({});
  const tools = buildWorkspaceTools(ws, { askUser: chose("A") });

  it("rejects an empty question", async () => {
    const out = await run(tools.ask_user, {
      question: "   ",
      options: ["A", "B"],
    });
    expect(out).toContain("ask_user error");
    expect(out.toLowerCase()).toContain("empty");
  });

  it("rejects fewer than 2 distinct options", async () => {
    const out = await run(tools.ask_user, {
      question: "Pick one",
      options: ["only"],
    });
    expect(out).toContain("ask_user error");
    expect(out).toContain("between 2 and 5");
  });

  it("rejects more than 5 options", async () => {
    const out = await run(tools.ask_user, {
      question: "Pick one",
      options: ["a", "b", "c", "d", "e", "f"],
    });
    expect(out).toContain("ask_user error");
    expect(out).toContain("between 2 and 5");
  });

  it("counts DISTINCT options — 6 raw that collapse to 5 is accepted", async () => {
    const captured: string[] = [];
    const t = buildWorkspaceTools(ws, {
      askUser: async (q) => {
        captured.push(...q.options);
        return { answer: q.options[0] ?? "", wasFreeText: false };
      },
    });
    const out = await run(t.ask_user, {
      question: "Pick one",
      options: ["a", "b", "c", "d", "e", "A"],
    });
    expect(out).not.toContain("error");
    expect(captured).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("ask_user abort handling", () => {
  it("returns an abort message when the turn signal is already aborted", async () => {
    const ws = new MemoryWorkspace({});
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const tools = buildWorkspaceTools(ws, {
      signal: controller.signal,
      askUser: async () => {
        called = true;
        return { answer: "A", wasFreeText: false };
      },
    });
    const out = await run(tools.ask_user, {
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    expect(out).toContain("aborted");
    // The callback must not fire once the turn is already gone.
    expect(called).toBe(false);
  });
});
