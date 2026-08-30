/**
 * AgentSidebar — proves the right-hand dock renders the two live panels from the
 * shared registries (Agent Team from the agent registry, Task Progress from the
 * task registry), honors its visibility modes, and hides on a narrow terminal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { AgentSidebar } from "../agent-sidebar.js";
import { agentRegistry } from "../../agent/agent-registry.js";
import { taskRegistry } from "../../agent/task-registry.js";

const NOW = 200_000;
const nowFn = (): number => NOW;
// A wide terminal so the dock is allowed to render; a narrow one to prove it hides.
const wide = (): number => 160;
const narrow = (): number => 60;

beforeEach(() => {
  agentRegistry.clear();
  taskRegistry.clear();
});
afterEach(() => {
  agentRegistry.clear();
  taskRegistry.clear();
});

describe("AgentSidebar", () => {
  it("renders nothing in auto mode when there is no activity", () => {
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="auto" nowFn={nowFn} widthFn={wide} />,
    );
    expect(lastFrame()).toBe("");
    unmount();
  });

  it("shows both panels (pinned on) even when idle", () => {
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="on" nowFn={nowFn} widthFn={wide} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent Team");
    expect(frame).toContain("Task Progress");
    expect(frame).toContain("No agents yet.");
    expect(frame).toContain("No plan yet.");
    unmount();
  });

  it("renders nothing when mode is off, even with activity", () => {
    agentRegistry.register({ kind: "turn", title: "do the thing" });
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="off" nowFn={nowFn} widthFn={wide} />,
    );
    expect(lastFrame()).toBe("");
    unmount();
  });

  it("hides on a narrow terminal despite being pinned on", () => {
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="on" nowFn={nowFn} widthFn={narrow} />,
    );
    expect(lastFrame()).toBe("");
    unmount();
  });

  it("lists the agent team from the agent registry", () => {
    agentRegistry.register({
      kind: "turn",
      title: "add rate limiting",
      model: "anthropic/claude-sonnet-5",
    });
    agentRegistry.register({
      kind: "subagent",
      title: "break-fix",
      detail: "fixing loop.ts",
    });
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="auto" nowFn={nowFn} widthFn={wide} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent Team");
    expect(frame).toContain("turn");
    expect(frame).toContain("add rate limiting");
    expect(frame).toContain("subagent");
    expect(frame).toContain("break-fix");
    expect(frame).toContain("2 total");
    unmount();
  });

  it("renders the task checklist with a done-count from the task registry", () => {
    taskRegistry.upsert("evaluate", {
      title: "Evaluate the request",
      status: "done",
    });
    taskRegistry.upsert("execute", {
      title: "Execute the work",
      status: "in_progress",
      detail: "editing",
    });
    const { lastFrame, unmount } = render(
      <AgentSidebar mode="auto" nowFn={nowFn} widthFn={wide} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Task Progress");
    expect(frame).toContain("Evaluate the request");
    expect(frame).toContain("Execute the work");
    expect(frame).toContain("1/2 done");
    unmount();
  });
});
