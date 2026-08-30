import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { SwarmPanel, resolveCtrlX, agentStatusStyle } from "../swarm-panel.js";
import type { RunningAgent } from "../../agent/agent-registry.js";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const ARROW_RIGHT = `${ESC}[C`;
const ARROW_LEFT = `${ESC}[D`;
const ENTER = "\r";
const CTRL_X = "\x18";

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

function agent(over: Partial<RunningAgent> & { id: string }): RunningAgent {
  return {
    id: over.id,
    kind: over.kind ?? "turn",
    title: over.title ?? over.id,
    status: over.status ?? "running",
    startedAt: over.startedAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    ...(over.model !== undefined ? { model: over.model } : {}),
    ...(over.detail !== undefined ? { detail: over.detail } : {}),
    ...(over.outputTokens !== undefined
      ? { outputTokens: over.outputTokens }
      : {}),
    ...(over.costUsd !== undefined ? { costUsd: over.costUsd } : {}),
  };
}

const SWARM: RunningAgent[] = [
  agent({
    id: "a1",
    kind: "turn",
    title: "add rate limiting",
    model: "anthropic/claude-sonnet-5",
    startedAt: 5000,
    outputTokens: 1200,
    costUsd: 0.05,
    detail: "editing loop.ts",
  }),
  agent({ id: "a2", kind: "subagent", title: "break-fix", status: "queued" }),
];

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof SwarmPanel>> = {},
) {
  const props: React.ComponentProps<typeof SwarmPanel> = {
    onClose: () => {},
    snapshot: () => SWARM,
    now: () => 12_000,
    pollMs: 20,
    ...overrides,
  };
  return render(<SwarmPanel {...props} />);
}

describe("resolveCtrlX", () => {
  it("arms an unarmed row and kills the same armed row", () => {
    expect(resolveCtrlX(null, "a1")).toBe("arm");
    expect(resolveCtrlX("a1", "a1")).toBe("kill");
    // Armed on a different row than the one now selected → re-arm, never kill.
    expect(resolveCtrlX("a1", "a2")).toBe("arm");
  });
});

describe("agentStatusStyle", () => {
  it("maps every status to a glyph + color", () => {
    expect(agentStatusStyle("running").glyph).toBe("●");
    expect(agentStatusStyle("queued").glyph).toBe("⧗");
    expect(agentStatusStyle("done").glyph).toBe("✓");
    expect(agentStatusStyle("failed").glyph).toBe("✗");
    expect(agentStatusStyle("killed").glyph).toBe("◼");
  });
});

describe("SwarmPanel", () => {
  it("lists every agent with kind, title, model, and tokens", async () => {
    const { lastFrame } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("add rate limiting"));
    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("Agent Swarm");
    expect(frame).toContain("1 running · 2 total");
    expect(frame).toContain("turn");
    expect(frame).toContain("add rate limiting");
    expect(frame).toContain("subagent");
    expect(frame).toContain("break-fix");
    expect(frame).toContain("1.2k tok");
  });

  it("shows the empty state when nothing is running", async () => {
    const { lastFrame } = renderPanel({ snapshot: () => [] });
    await until(() => (lastFrame() ?? "").includes("No agents yet"));
  });

  it("moves the selection with the arrow keys, wrapping", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    expect(lastFrame()).toMatch(/❯.*add rate limiting/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*break-fix/.test(lastFrame() ?? ""));
    stdin.write(ARROW_DOWN); // wraps to the first row
    await until(() => /❯.*add rate limiting/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP); // wraps to the last row
    await until(() => /❯.*break-fix/.test(lastFrame() ?? ""));
  });

  it("Enter drills into detail (usage + activity), Esc/← steps back", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("editing loop.ts"));
    const detail = stripAnsi(lastFrame()!);
    expect(detail).toContain("add rate limiting");
    expect(detail).toContain("1.2k tok");
    expect(detail).toContain("$0.05");
    expect(detail).toContain("back to the swarm");
    stdin.write(ARROW_LEFT);
    await until(() => (lastFrame() ?? "").includes("↑↓ navigate"));
    stdin.write(ARROW_RIGHT); // drill again, then Esc back
    await until(() => (lastFrame() ?? "").includes("back to the swarm"));
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("↑↓ navigate"));
  });

  it("double Ctrl-X kills the highlighted agent via onKill; a single press only arms", async () => {
    const onKill = vi.fn(() => true);
    const { lastFrame, stdin } = renderPanel({ onKill });
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(CTRL_X);
    await until(() => (lastFrame() ?? "").includes("ctrl+x again to kill"));
    expect(onKill).not.toHaveBeenCalled();
    stdin.write(CTRL_X);
    await until(() => onKill.mock.calls.length > 0);
    expect(onKill).toHaveBeenCalledWith("a1");
    await until(() => (lastFrame() ?? "").includes("killed add rate limiting"));
  });

  it("reports no kill handle when onKill returns false", async () => {
    const { lastFrame, stdin } = renderPanel(); // default onKill → false
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(CTRL_X);
    await until(() => (lastFrame() ?? "").includes("ctrl+x again to kill"));
    stdin.write(CTRL_X);
    await until(() =>
      (lastFrame() ?? "").includes("no kill handle — dismissed"),
    );
  });

  it("any other key disarms the kill chain", async () => {
    const onKill = vi.fn(() => true);
    const { lastFrame, stdin } = renderPanel({ onKill });
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(CTRL_X);
    await until(() => (lastFrame() ?? "").includes("ctrl+x again to kill"));
    stdin.write(ARROW_DOWN); // disarms + moves selection
    await until(() => !(lastFrame() ?? "").includes("ctrl+x again to kill"));
    stdin.write(CTRL_X); // arms the newly-selected row instead of killing
    await until(() => (lastFrame() ?? "").includes("ctrl+x again to kill"));
    expect(onKill).not.toHaveBeenCalled();
  });

  it("Esc closes the panel from the list", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onClose });
    await until(() => (lastFrame() ?? "").includes("Agent Swarm"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });

  it("live-updates as the snapshot changes", async () => {
    let swarm: RunningAgent[] = [agent({ id: "solo", title: "lonely turn" })];
    const { lastFrame } = renderPanel({ snapshot: () => swarm });
    await until(() => (lastFrame() ?? "").includes("lonely turn"));
    expect(lastFrame()).toContain("1 total");
    swarm = [
      agent({ id: "solo", title: "lonely turn" }),
      agent({ id: "worker", kind: "subagent", title: "new worker" }),
    ];
    await until(() => (lastFrame() ?? "").includes("new worker"));
    expect(lastFrame()).toContain("2 total");
  });
});
