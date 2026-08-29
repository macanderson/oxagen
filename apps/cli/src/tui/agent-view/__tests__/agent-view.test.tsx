/**
 * Ink tests for the Agent View dashboard. Data is injected as a one-shot
 * `collect` so the render is deterministic (no DuckDB, no socket, no store);
 * we poll frames with a deadline, never fixed sleeps. Covered: the real audit
 * table paints recorded runs, the real empty state, real spend + code-graph
 * stats render, and `q` quits.
 */
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentView } from "../index.js";
import type { AgentViewData } from "../data.js";

// Observe quit without a real TTY: ink-testing-library has no waitUntilExit, so
// we spy on the `exit` the view calls, preserving the rest of ink.
const exitMock = vi.hoisted(() => vi.fn());
vi.mock("ink", async (importActual) => {
  const actual = await importActual<typeof import("ink")>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

async function until(
  cond: () => boolean,
  timeoutMs = 3000,
  frame?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      const tail = frame ? `\n--- last frame ---\n${frame()}` : "";
      throw new Error(`until(): condition not met in time${tail}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const baseData = (over: Partial<AgentViewData> = {}): AgentViewData => ({
  auth: {
    mode: "platform",
    orgSlug: "acme",
    workspaceSlug: "prod",
    label: "acme / prod",
    ok: true,
  },
  rows: [],
  rollup: {
    total: 0,
    byState: {
      running: 0,
      waiting: 0,
      queued: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      orphaned: 0,
    },
    active: 0,
    fleetRuns: 0,
    interactiveRuns: 0,
    costUsdTotal: 0,
    costUsdToday: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastActivityAt: null,
  },
  activity: [],
  codeGraph: { state: "absent", dbPath: "/x.duckdb" },
  daemon: { running: false, socketPath: "/x.sock" },
  fleetRoot: "/root",
  projectRoot: "/Users/dev/oxagen",
  generatedAt: Date.now(),
  ...over,
});

const mount = (data: AgentViewData) =>
  render(
    <AgentView
      cwd="/Users/dev/oxagen"
      collect={async () => data}
      refreshMs={0}
    />,
  );

describe("AgentView", () => {
  it("shows the real empty state and off-source health when nothing exists", async () => {
    const { lastFrame, unmount } = mount(baseData());
    await until(
      () => (lastFrame() ?? "").includes("No agent runs recorded"),
      3000,
      () => lastFrame() ?? "",
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("agent audit");
    expect(frame).toContain("oxagen"); // project name in header
    expect(frame).toContain("daemon off");
    expect(frame).toContain("graph absent");
    unmount();
  });

  it("renders recorded runs with real cost and code-graph stats", async () => {
    const now = Date.now();
    const data = baseData({
      rows: [
        {
          sid: "s-abc-7f2q",
          title: "ship the audit view",
          state: "done",
          live: false,
          owner: "worker",
          model: "fable-5",
          turns: 3,
          startedAt: now - 60_000,
          durationMs: 60_000,
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 },
          updatedAt: now,
        },
      ],
      rollup: {
        total: 1,
        byState: {
          running: 0,
          waiting: 0,
          queued: 0,
          done: 1,
          failed: 0,
          cancelled: 0,
          orphaned: 0,
        },
        active: 0,
        fleetRuns: 1,
        interactiveRuns: 0,
        costUsdTotal: 0.25,
        costUsdToday: 0.25,
        inputTokens: 100,
        outputTokens: 50,
        lastActivityAt: now,
      },
      codeGraph: {
        state: "ready",
        dbPath: "/x.duckdb",
        root: "/Users/dev/oxagen",
        files: 120,
        symbols: 900,
        edges: 1500,
        embeddedFiles: 100,
        lastIndexedAt: now - 5000,
      },
      daemon: {
        running: true,
        socketPath: "/x.sock",
        pid: 42,
        uptimeSeconds: 90,
      },
    });
    const { lastFrame, unmount } = mount(data);
    // The title truncates to fit its column, so assert on the surviving prefix.
    await until(
      () => (lastFrame() ?? "").includes("ship the audit"),
      3000,
      () => lastFrame() ?? "",
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("AGENT RUNS");
    expect(frame).toContain("$0.25"); // real recorded cost
    expect(frame).toContain("fable-5");
    expect(frame).toContain("CODE GRAPH");
    expect(frame).toContain("graph ready");
    expect(frame).toContain("daemon"); // running indicator present
    unmount();
  });

  it("quits on q", async () => {
    exitMock.mockClear();
    const { stdin, lastFrame, unmount } = mount(baseData());
    await until(() => (lastFrame() ?? "").length > 0);
    stdin.write("q");
    await until(
      () => exitMock.mock.calls.length > 0,
      3000,
      () => lastFrame() ?? "",
    );
    unmount();
  });
});
