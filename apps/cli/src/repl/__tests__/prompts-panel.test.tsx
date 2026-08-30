import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  PromptsPanel,
  filterPrompts,
  type SavedPrompt,
} from "../prompts-panel.js";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const ENTER = "\r";
const BACKSPACE = "\x7f";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const PROMPTS: SavedPrompt[] = [
  {
    name: "code-review",
    description: "review the current diff",
    body: "Please review this diff.",
  },
  {
    name: "explain",
    description: "explain a file",
    body: "Explain what this file does.",
  },
  {
    name: "long-doc",
    description: "a long prompt body",
    body: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
  },
];

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof PromptsPanel>> = {},
) {
  const props: React.ComponentProps<typeof PromptsPanel> = {
    onClose: () => {},
    prompts: PROMPTS,
    onInsert: () => {},
    ...overrides,
  };
  return render(<PromptsPanel {...props} />);
}

describe("filterPrompts", () => {
  it("returns all prompts for an empty query and filters by name + description", () => {
    expect(filterPrompts(PROMPTS, "").length).toBe(3);
    expect(filterPrompts(PROMPTS, "review").map((p) => p.name)).toEqual([
      "code-review",
    ]);
    // Matches the description too ("explain a file").
    expect(filterPrompts(PROMPTS, "file").map((p) => p.name)).toEqual([
      "explain",
    ]);
    expect(filterPrompts(PROMPTS, "ZZZ")).toEqual([]);
  });
});

describe("PromptsPanel", () => {
  it("lists the saved prompts", async () => {
    const { lastFrame } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("code-review"));
    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("Saved Prompts");
    expect(frame).toContain("code-review");
    expect(frame).toContain("review the current diff");
    expect(frame).toContain("explain");
  });

  it("shows the empty state and a create hint when there are no prompts", async () => {
    const onCreateNew = vi.fn();
    const { lastFrame } = renderPanel({ prompts: [], onCreateNew });
    await until(() => (lastFrame() ?? "").includes("No saved prompts yet"));
    expect(lastFrame()).toContain("press n to create one");
  });

  it("moves the selection with the arrow keys, wrapping", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    expect(lastFrame()).toMatch(/❯.*code-review/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*explain/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP);
    await until(() => /❯.*code-review/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP); // wraps to the last row
    await until(() => /❯.*long-doc/.test(lastFrame() ?? ""));
  });

  it("Enter inserts the highlighted prompt's body and closes", async () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onInsert, onClose });
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => onInsert.mock.calls.length > 0);
    expect(onInsert).toHaveBeenCalledWith("Please review this diff.");
    await until(() => onClose.mock.calls.length > 0);
  });

  it("v toggles a scrollable preview of the body", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ARROW_UP); // select the long-doc prompt (last, wraps)
    await until(() => /❯.*long-doc/.test(lastFrame() ?? ""));
    stdin.write("v");
    await until(() => (lastFrame() ?? "").includes("preview"));
    expect(lastFrame()).toContain("line 1");
    // Scroll down reveals later lines that the first window didn't include.
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    stdin.write(ARROW_DOWN);
    await until(() => (lastFrame() ?? "").includes("line 20"));
    stdin.write("v"); // toggle back to the list
    await until(() => (lastFrame() ?? "").includes("↑↓ navigate"));
  });

  it("n triggers onCreateNew", async () => {
    const onCreateNew = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onCreateNew });
    await until(() => (lastFrame() ?? "").includes("code-review"));
    stdin.write("n");
    await until(() => onCreateNew.mock.calls.length > 0);
  });

  it("type-to-filter narrows the list and backspace widens it", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("code-review"));
    stdin.write("expl");
    await until(() => {
      const f = stripAnsi(lastFrame() ?? "");
      return f.includes("explain") && !f.includes("code-review");
    });
    expect(stripAnsi(lastFrame()!)).toContain('match "expl"');
    stdin.write(BACKSPACE);
    stdin.write(BACKSPACE);
    stdin.write(BACKSPACE);
    stdin.write(BACKSPACE);
    await until(() => stripAnsi(lastFrame() ?? "").includes("code-review"));
  });

  it("shows a no-match state for a query that matches nothing", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("code-review"));
    stdin.write("zzz");
    await until(() => (lastFrame() ?? "").includes("No prompts match"));
  });

  it("Esc closes the panel", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onClose });
    await until(() => (lastFrame() ?? "").includes("Saved Prompts"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });
});
