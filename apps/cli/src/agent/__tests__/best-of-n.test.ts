/**
 * runBestOfN orchestration flow — N candidates in isolation, comparative
 * selection, winner applied. git + verify + runTurn are mocked (no real repo,
 * no model), so this asserts the control flow + event stream, not git itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture git invocations and hand back canned stdout per subcommand.
const gitCalls: string[][] = [];
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    gitCalls.push(args);
    cb(null, { stdout: "", stderr: "" });
  },
}));

const runTurnMock = vi.fn();
const selectMock = vi.fn();
vi.mock("@oxagen/agent-engine", () => ({
  runTurn: (a: unknown) => runTurnMock(a),
  selectBestCandidate: (a: unknown) => selectMock(a),
  looksPassing: (o: string | undefined) => Boolean(o && !/fail/i.test(o)),
}));
vi.mock("../adapters/index.js", () => ({
  createCwdWorkspace: vi.fn(() => ({ root: "/wt" })),
  createCodeGraphProvider: vi.fn(() => ({})),
}));
vi.mock("../code-graph.js", () => ({ queryCodeGraph: vi.fn() }));
const verifyMock = vi.fn();
vi.mock("../../lib/shell-runner.js", () => ({
  runShellCommandBuffered: (a: unknown) => verifyMock(a),
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/bestof-xyz"),
  rm: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

import { runBestOfN, type BestOfNEvent } from "../best-of-n.js";
import type { AgentAi } from "@oxagen/agent-engine";

beforeEach(() => {
  gitCalls.length = 0;
  runTurnMock.mockReset();
  selectMock.mockReset();
  verifyMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: "2 passed", stderr: "", timedOut: false });
});

const ai = { stream: vi.fn(), generateObject: vi.fn() } as unknown as AgentAi;

describe("runBestOfN", () => {
  it("runs N candidates, selects a winner, applies it, and emits the full event stream", async () => {
    // Each candidate turn fires onFileChange with its own diff.
    let call = 0;
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void; onStage?: (s: { label: string }) => void }) => {
      call++;
      const diff = `--- a/x.py\n+++ b/x.py\n+cand${call}`;
      o.onStage?.({ label: "executing" });
      o.onFileChange?.(diff, ["x.py"]);
      return { text: `candidate ${call}`, steps: 3, messages: [], usage: {}, trace: { id: `t${call}` } };
    });
    selectMock.mockResolvedValue({
      winnerId: "candidate-2",
      reasoning: "candidate-2's tests pass",
      ranking: [{ id: "candidate-2", score: 90, note: "pass" }],
      model: "openai/gpt-4o",
      fallback: false,
      usage: {},
    });

    const events: BestOfNEvent[] = [];
    const result = await runBestOfN({
      prompt: "fix the bug",
      cwd: "/repo",
      candidates: 3,
      ai,
      verifyCommand: "pytest -q",
      onEvent: (e) => events.push(e),
    });

    // Winner selected + returned.
    expect(result.selection.winnerId).toBe("candidate-2");
    expect(result.winner?.id).toBe("candidate-2");

    // Three candidate turns + three verify runs.
    expect(runTurnMock).toHaveBeenCalledTimes(3);
    expect(verifyMock).toHaveBeenCalledTimes(3);

    // Event stream covers the whole race.
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types.filter((t) => t === "candidate-start")).toHaveLength(3);
    expect(types.filter((t) => t === "candidate-done")).toHaveLength(3);
    expect(types).toContain("select-start");
    expect(types).toContain("select-done");
    expect(types).toContain("applied");

    // A worktree was created per candidate and the winner applied.
    expect(gitCalls.filter((a) => a[0] === "worktree" && a[1] === "add")).toHaveLength(3);
    expect(gitCalls.some((a) => a[0] === "apply")).toBe(true);
  });

  it("does not apply anything in readOnly mode", async () => {
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "c", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    const events: BestOfNEvent[] = [];
    await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 2, ai, readOnly: true, onEvent: (e) => events.push(e) });

    expect(events.some((e) => e.type === "applied")).toBe(false);
    expect(gitCalls.some((a) => a[0] === "apply")).toBe(false);
  });

  it("marks a candidate failed when its turn throws, without sinking the run", async () => {
    let call = 0;
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      call++;
      if (call === 1) throw new Error("model exploded");
      o.onFileChange?.("--- a/x\n+++ b/x\n+ok", ["x"]);
      return { text: "ok", steps: 2, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-2", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    const events: BestOfNEvent[] = [];
    const result = await runBestOfN({ prompt: "fix", cwd: "/repo", candidates: 2, ai, onEvent: (e) => events.push(e) });

    expect(events.some((e) => e.type === "candidate-failed")).toBe(true);
    expect(result.candidates.find((c) => c.id === "candidate-1")?.failed).toBe(true);
    expect(result.winner?.id).toBe("candidate-2"); // the surviving candidate won
  });

  it("passes runTurn no model (not a placeholder string) when none is pinned, so the engine's own default applies", async () => {
    // Regression test: `models` used to fall back to the literal string
    // "default" and pass it straight to runTurn, which forwards it to the
    // gateway as-is — "default" is not a real gateway slug, so every
    // unpinned candidate failed to resolve a model. The fix: pass `undefined`
    // to the engine (its own fallback applies) and keep "default" only as a
    // separate, display-only label.
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    const events: BestOfNEvent[] = [];
    const result = await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 1, ai, onEvent: (e) => events.push(e) });

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock.mock.calls[0]![0]).toMatchObject({ model: undefined });

    // Display-only label stays human-readable ("default", not undefined).
    const startEvent = events.find((e) => e.type === "candidate-start");
    expect(startEvent).toMatchObject({ model: "default" });
    expect(result.candidates[0]?.model).toBe("default");
  });

  it("pins every candidate to an explicitly given model", async () => {
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 2, ai, models: ["openai/gpt-4o"] });

    expect(runTurnMock).toHaveBeenCalledTimes(2);
    expect(runTurnMock.mock.calls[0]![0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(runTurnMock.mock.calls[1]![0]).toMatchObject({ model: "openai/gpt-4o" });
  });
});
