/**
 * Side-panel keyboard navigation — proves the pieces that power arrow-key
 * traversal of the Agent Team / Task Progress dock:
 *   • panelNavTargets: the flat "agents then tasks" nav order.
 *   • stepPanelFocus: the pure up/down boundary math (into the bar, stay at the
 *     bottom, recover from a stale highlight).
 *   • AgentSidebar: highlights the focused row and force-shows while `active`.
 *   • AgentFocusView: the drilled-in agent log (and null for an unknown id).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  AgentSidebar,
  AgentFocusView,
  panelNavTargets,
  stepPanelFocus,
  type PanelTarget,
} from "../agent-sidebar.js";
import {
  agentRegistry,
  type RunningAgent,
} from "../../agent/agent-registry.js";
import { taskRegistry, type TrackedTask } from "../../agent/task-registry.js";

const NOW = 200_000;
const nowFn = (): number => NOW;
const wide = (): number => 160;

// Minimal registry shapes for the pure helpers (only id/zone are read).
const agent = (id: string): RunningAgent =>
  ({
    id,
    kind: "turn",
    title: id,
    status: "running",
    startedAt: 0,
    updatedAt: 0,
  }) as RunningAgent;
const task = (id: string): TrackedTask =>
  ({
    id,
    title: id,
    status: "pending",
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }) as TrackedTask;

beforeEach(() => {
  agentRegistry.clear();
  taskRegistry.clear();
});
afterEach(() => {
  agentRegistry.clear();
  taskRegistry.clear();
});

describe("panelNavTargets", () => {
  it("lists every agent (roster order) then every task (plan order)", () => {
    const targets = panelNavTargets([agent("a1"), agent("a2")], [task("t1")]);
    expect(targets).toEqual([
      { zone: "agent", id: "a1" },
      { zone: "agent", id: "a2" },
      { zone: "task", id: "t1" },
    ]);
  });

  it("is empty when both lists are empty", () => {
    expect(panelNavTargets([], [])).toEqual([]);
  });
});

describe("stepPanelFocus", () => {
  const targets: PanelTarget[] = [
    { zone: "agent", id: "a1" },
    { zone: "agent", id: "a2" },
    { zone: "task", id: "t1" },
  ];

  it("moves down through agents into tasks", () => {
    expect(stepPanelFocus(targets, { zone: "agent", id: "a1" }, 1)).toEqual({
      zone: "agent",
      id: "a2",
    });
    expect(stepPanelFocus(targets, { zone: "agent", id: "a2" }, 1)).toEqual({
      zone: "task",
      id: "t1",
    });
  });

  it("stays put stepping down past the last row (returns the same ref)", () => {
    const cur = targets[2]!;
    expect(stepPanelFocus(targets, cur, 1)).toBe(cur);
  });

  it("returns null (→ input bar) stepping up off the first row", () => {
    expect(stepPanelFocus(targets, { zone: "agent", id: "a1" }, -1)).toBeNull();
  });

  it("moves up from a task back into agents", () => {
    expect(stepPanelFocus(targets, { zone: "task", id: "t1" }, -1)).toEqual({
      zone: "agent",
      id: "a2",
    });
  });

  it("returns null when the current row no longer exists (stale highlight)", () => {
    expect(stepPanelFocus(targets, { zone: "task", id: "gone" }, 1)).toBeNull();
    expect(
      stepPanelFocus(targets, { zone: "task", id: "gone" }, -1),
    ).toBeNull();
  });
});

describe("AgentSidebar focus + active", () => {
  it("marks the focused agent row with the pointer glyph", () => {
    agentRegistry.register({
      kind: "turn",
      title: "add rate limiting",
      id: "agent-1",
    });
    const { lastFrame, unmount } = render(
      <AgentSidebar
        mode="on"
        nowFn={nowFn}
        widthFn={wide}
        focus={{ zone: "agent", id: "agent-1" }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("add rate limiting");
    // The FocusMarker pointer only renders on the highlighted row.
    expect(frame).toContain("❯");
    // The keybinding legend shows only while a row holds focus.
    expect(frame).toContain("Ctrl-E open");
    unmount();
  });

  it("shows no pointer and no legend when focus is null", () => {
    agentRegistry.register({
      kind: "turn",
      title: "idle agent",
      id: "agent-1",
    });
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="on" nowFn={nowFn} widthFn={wide} focus={null} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("idle agent");
    expect(frame).not.toContain("❯");
    expect(frame).not.toContain("Ctrl-E open");
    unmount();
  });

  it("force-shows an idle auto dock when active (navigated into)", () => {
    // Auto + no activity would normally render nothing; active overrides that.
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="auto" nowFn={nowFn} widthFn={wide} active />,
    );
    expect(lastFrame() ?? "").toContain("Agent Team");
    unmount();
  });
});

describe("AgentFocusView", () => {
  it("renders the drilled-in agent's live log", () => {
    agentRegistry.register({
      kind: "subagent",
      title: "break-fix loop.ts",
      id: "agent-9",
      detail: "editing loop.ts",
    });
    const { lastFrame, unmount } = render(
      <AgentFocusView agentId="agent-9" nowFn={nowFn} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent log");
    expect(frame).toContain("break-fix loop.ts");
    expect(frame).toContain("editing loop.ts");
    unmount();
  });

  it("renders nothing for an unknown / pruned agent id", () => {
    const { lastFrame, unmount } = render(
      <AgentFocusView agentId="ghost" nowFn={nowFn} />,
    );
    expect(lastFrame()).toBe("");
    unmount();
  });
});
