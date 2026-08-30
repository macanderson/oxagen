import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  TasksPanel,
  taskStatusStyle,
  formatElapsed,
  taskElapsedMs,
} from "../tasks-panel.js";
import type { TrackedTask } from "../../agent/task-registry.js";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const ARROW_LEFT = `${ESC}[D`;
const ARROW_RIGHT = `${ESC}[C`;
const ENTER = "\r";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously. */
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

function task(over: Partial<TrackedTask> & { id: string }): TrackedTask {
  return {
    id: over.id,
    title: over.title ?? over.id,
    status: over.status ?? "pending",
    order: over.order ?? 0,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    ...(over.detail !== undefined ? { detail: over.detail } : {}),
  };
}

const PLAN: TrackedTask[] = [
  task({
    id: "evaluate",
    title: "Evaluate the request",
    status: "done",
    createdAt: 1000,
    updatedAt: 4000,
  }),
  task({
    id: "execute",
    title: "Execute the work",
    status: "in_progress",
    createdAt: 5000,
    detail: "editing loop.ts",
  }),
  task({ id: "judge", title: "Judge the result", status: "pending" }),
];

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof TasksPanel>> = {},
) {
  const props: React.ComponentProps<typeof TasksPanel> = {
    onClose: () => {},
    snapshot: () => PLAN,
    now: () => 12_000,
    pollMs: 20,
    ...overrides,
  };
  return render(<TasksPanel {...props} />);
}

describe("taskStatusStyle", () => {
  it("maps every status to a glyph + color", () => {
    expect(taskStatusStyle("pending").glyph).toBe("○");
    expect(taskStatusStyle("in_progress").glyph).toBe("◐");
    expect(taskStatusStyle("done").glyph).toBe("✓");
    expect(taskStatusStyle("failed").glyph).toBe("✗");
  });
});

describe("formatElapsed", () => {
  it("renders sub-minute spans in seconds and longer spans as m/s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(64_000)).toBe("1m04s");
    expect(formatElapsed(-500)).toBe("0s");
  });
});

describe("taskElapsedMs", () => {
  it("counts up for running, shows duration for finished, nothing for pending", () => {
    expect(
      taskElapsedMs(
        task({ id: "a", status: "in_progress", createdAt: 5000 }),
        12_000,
      ),
    ).toBe(7000);
    expect(
      taskElapsedMs(
        task({ id: "b", status: "done", createdAt: 1000, updatedAt: 4000 }),
        99_000,
      ),
    ).toBe(3000);
    expect(
      taskElapsedMs(
        task({ id: "c", status: "failed", createdAt: 1000, updatedAt: 2500 }),
        99_000,
      ),
    ).toBe(1500);
    expect(
      taskElapsedMs(task({ id: "d", status: "pending" }), 12_000),
    ).toBeNull();
  });
});

describe("TasksPanel", () => {
  it("renders each stage with glyph, title, and elapsed", async () => {
    const { lastFrame } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("Execute the work"));
    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("Task Progress");
    expect(frame).toContain("3 tasks · 1 done");
    expect(frame).toContain("Evaluate the request");
    expect(frame).toContain("Execute the work");
    expect(frame).toContain("Judge the result");
    // done stage took 3s (1000 → 4000); running stage counts to now (5000 → 12000).
    expect(frame).toContain("3s");
    expect(frame).toContain("7s");
  });

  it("shows the empty state when there is no plan", async () => {
    const { lastFrame } = renderPanel({ snapshot: () => [] });
    await until(() => (lastFrame() ?? "").includes("No plan yet"));
  });

  it("moves the selection with the arrow keys, wrapping", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    expect(lastFrame()).toMatch(/❯.*Evaluate/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*Execute/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP); // wraps back up to the first row
    await until(() => /❯.*Evaluate/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP); // wraps to the last row
    await until(() => /❯.*Judge/.test(lastFrame() ?? ""));
  });

  it("Enter drills into the selected task's detail, Esc steps back", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onClose });
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ARROW_DOWN); // select the running "Execute" stage
    await until(() => /❯.*Execute/.test(lastFrame() ?? ""));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("editing loop.ts"));
    const detail = stripAnsi(lastFrame()!);
    expect(detail).toContain("Execute the work");
    expect(detail).toContain("in_progress");
    expect(detail).toContain("running");
    expect(detail).toContain("back to the task list");
    // Esc steps back to the list rather than closing the panel.
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("↑↓ navigate"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("→ drills in and ← steps back out of the detail", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ARROW_RIGHT);
    await until(() => (lastFrame() ?? "").includes("back to the task list"));
    stdin.write(ARROW_LEFT);
    await until(() => (lastFrame() ?? "").includes("↑↓ navigate"));
  });

  it("Esc closes the panel from the list", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onClose });
    await until(() => (lastFrame() ?? "").includes("Task Progress"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });

  it("live-updates as the snapshot changes", async () => {
    let plan: TrackedTask[] = [
      task({ id: "one", title: "First stage", status: "in_progress" }),
    ];
    const { lastFrame } = renderPanel({ snapshot: () => plan });
    await until(() => (lastFrame() ?? "").includes("First stage"));
    expect(lastFrame()).toContain("1 task");
    plan = [
      task({ id: "one", title: "First stage", status: "done" }),
      task({
        id: "two",
        title: "Second stage",
        status: "in_progress",
        order: 1,
      }),
    ];
    await until(() => (lastFrame() ?? "").includes("Second stage"));
    expect(lastFrame()).toContain("2 tasks · 1 done");
  });
});
