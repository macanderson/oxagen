/**
 * Tests for the agents-screen entry point (`launchFleetView`). Every
 * data-layer seam is mocked at the module boundary — the Fleet constructor,
 * planner, fleet memory, plan store, worktree isolation, project context,
 * agent loader, server memory, and ink's render — so the wiring itself is
 * what's under test: headless-vs-TTY routing, the goal → plan closure (plans
 * once, persists before the fleet's own writes), the isolation on/off
 * branches, the platform-memory gate, and worktree cleanup on every exit
 * path. `process.stdout.isTTY` is stubbed per test (vitest itself runs
 * headless) and `process.exitCode` is restored so a tested failure path
 * cannot fail the test process.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { FleetSnapshot, Plan } from "../../../agent/fleet/types.js";

const fleetSnapshot: FleetSnapshot = {
  agents: [],
  queuedCount: 0,
  runningCount: 0,
  doneCount: 0,
  failedCount: 0,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  concurrency: 4,
};

const {
  fleetCtor,
  planTasksMock,
  runHeadlessMock,
  storeSaveMock,
  cleanupAllMock,
  worktreeCtor,
  isGitRepoMock,
  resolveApiContextMock,
  createServerMemoryMock,
  renderMock,
  waitUntilExitMock,
} = vi.hoisted(() => ({
  fleetCtor: vi.fn(),
  planTasksMock: vi.fn(),
  runHeadlessMock: vi.fn(),
  storeSaveMock: vi.fn(),
  cleanupAllMock: vi.fn(async () => {}),
  worktreeCtor: vi.fn(),
  isGitRepoMock: vi.fn(async () => false),
  resolveApiContextMock: vi.fn(() => null),
  createServerMemoryMock: vi.fn((_opts: unknown) => ({ kind: "server-memory" })),
  renderMock: vi.fn(),
  waitUntilExitMock: vi.fn(async () => {}),
}));

vi.mock("../../../agent/fleet/orchestrator.js", () => ({
  Fleet: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
      fleetCtor(opts);
    }
    snapshot(): FleetSnapshot {
      return fleetSnapshot;
    }
  },
}));
vi.mock("../../../agent/planner.js", () => ({
  planTasks: planTasksMock,
}));
vi.mock("../../../agent/fleet/memory.js", () => ({
  openFleetMemory: vi.fn(() => ({ kind: "fleet-memory" })),
}));
vi.mock("../../../agent/fleet/headless.js", () => ({
  runFleetHeadless: runHeadlessMock,
}));
vi.mock("../../../agent/adapters/index.js", () => ({
  createServerMemory: createServerMemoryMock,
}));
vi.mock("../../../lib/api.js", () => ({
  resolveApiContext: resolveApiContextMock,
}));
vi.mock("../../../agent/fleet/store.js", () => ({
  openPlanStore: vi.fn(() => ({ save: storeSaveMock })),
}));
vi.mock("../../../agent/fleet/git-isolation.js", () => ({
  isGitRepo: isGitRepoMock,
  WorktreeManager: class {
    constructor(opts: unknown) {
      worktreeCtor(opts);
    }
    cleanupAll = cleanupAllMock;
  },
}));
vi.mock("../../../agent/project-context.js", () => ({
  loadProjectContext: vi.fn(() => "PROJECT CONTEXT"),
}));
vi.mock("../../../agents/loader.js", () => ({
  loadAgents: vi.fn(() => new Map()),
}));
// Keep ink real except `render` — the TTY path must not paint a real screen.
vi.mock("ink", async (importActual) => {
  const actual = await importActual<typeof import("ink")>();
  return {
    ...actual,
    render: renderMock.mockReturnValue({ waitUntilExit: waitUntilExitMock }),
  };
});

import { launchFleetView } from "../index.js";

const madePlan: Plan = {
  id: "p-1",
  goal: "add rate limiting",
  createdAt: 1,
  tasks: [],
  status: "draft",
};

/** Stub the TTY flag for one test; vitest's stdout is not a TTY. */
const setTty = (isTTY: boolean | undefined): void => {
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTTY,
    configurable: true,
    writable: true,
  });
};

const originalTty = process.stdout.isTTY;
// Named helper so the spy's overloaded type is inferred, not hand-spelled.
const spyOnStderr = () => vi.spyOn(process.stderr, "write").mockReturnValue(true);
let stderrSpy: ReturnType<typeof spyOnStderr>;

beforeEach(() => {
  runHeadlessMock.mockResolvedValue(fleetSnapshot);
  planTasksMock.mockResolvedValue(madePlan);
  stderrSpy = spyOnStderr();
});

afterEach(() => {
  setTty(originalTty);
  process.exitCode = 0;
  stderrSpy.mockRestore();
});

describe("launchFleetView", () => {
  it("headless without a goal refuses with an actionable stderr line", async () => {
    setTty(false);
    const snap = await launchFleetView({ cwd: "/repo/proj", headless: true });
    expect(snap).toBe(fleetSnapshot);
    expect(process.exitCode).toBe(1);
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("requires a goal");
    expect(runHeadlessMock).not.toHaveBeenCalled();
    // Not a git repo → no isolation → nothing to clean up.
    expect(cleanupAllMock).not.toHaveBeenCalled();
  });

  it("headless with a goal runs the headless fleet and plans exactly once", async () => {
    setTty(false);
    isGitRepoMock.mockResolvedValue(true);
    const snap = await launchFleetView({ cwd: "/repo/proj", goal: "add rate limiting" });
    expect(snap).toBe(fleetSnapshot);
    expect(runHeadlessMock).toHaveBeenCalledTimes(1);

    // Drive the plan closure runFleetHeadless received: it must decompose the
    // goal via planTasks and persist to the store before returning.
    const arg = runHeadlessMock.mock.calls[0]?.[0] as {
      plan: (signal: AbortSignal) => Promise<Plan>;
    };
    const planned = await arg.plan(new AbortController().signal);
    expect(planned).toBe(madePlan);
    expect(planTasksMock).toHaveBeenCalledTimes(1);
    expect(planTasksMock.mock.calls[0]?.[0]).toMatchObject({
      goal: "add rate limiting",
      cwd: "/repo/proj",
    });
    expect(storeSaveMock).toHaveBeenCalledWith(madePlan);

    // Git repo + writable → worktree isolation on, swept in the finally.
    expect(worktreeCtor).toHaveBeenCalledTimes(1);
    expect(cleanupAllMock).toHaveBeenCalledTimes(1);
  });

  it("renders the live FleetApp on a TTY and sweeps worktrees after exit", async () => {
    setTty(true);
    isGitRepoMock.mockResolvedValue(true);
    const snap = await launchFleetView({ cwd: "/repo/proj" });
    expect(snap).toBe(fleetSnapshot);
    expect(renderMock).toHaveBeenCalledTimes(1);
    // Ctrl-C belongs to FleetApp's cancel-drain, not ink.
    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({ exitOnCtrlC: false });
    expect(waitUntilExitMock).toHaveBeenCalledTimes(1);
    expect(cleanupAllMock).toHaveBeenCalledTimes(1);
    expect(runHeadlessMock).not.toHaveBeenCalled();
  });

  it("skips isolation for read-only fleets and when --no-isolate is passed", async () => {
    setTty(true);
    isGitRepoMock.mockResolvedValue(true);
    await launchFleetView({ cwd: "/repo/proj", readOnly: true });
    await launchFleetView({ cwd: "/repo/proj", isolate: false });
    expect(worktreeCtor).not.toHaveBeenCalled();
    expect(cleanupAllMock).not.toHaveBeenCalled();
  });

  it("opens platform memory only when the CLI is authenticated", async () => {
    setTty(true);
    await launchFleetView({ cwd: "/repo/proj" });
    expect(createServerMemoryMock).not.toHaveBeenCalled(); // anonymous → local-only

    resolveApiContextMock.mockReturnValue({ token: "t" } as never);
    await launchFleetView({ cwd: "/repo/proj" });
    expect(createServerMemoryMock).toHaveBeenCalledTimes(1);
    expect(createServerMemoryMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: "fleet",
      projectName: "proj",
    });
    // The wired handle reaches the Fleet constructor.
    expect(fleetCtor.mock.calls.at(-1)?.[0]).toMatchObject({
      serverMemory: { kind: "server-memory" },
    });
  });
});
