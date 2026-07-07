/**
 * runBestOfN orchestration flow — N candidates in isolation, comparative
 * selection, winner applied. git + verify + runTurn are mocked (no real repo,
 * no model), so this asserts the control flow + event stream, not git itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture git invocations and hand back canned stdout per subcommand.
const gitCalls: string[][] = [];
// How many of the NEXT `git apply` calls should report failure — lets a test
// simulate the winner's diff rejecting so the apply-fallback loop kicks in.
let applyFailuresRemaining = 0;
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
  ) => {
    gitCalls.push(args);
    if (args[0] === "apply" && applyFailuresRemaining > 0) {
      applyFailuresRemaining--;
      cb(null, { stdout: "error: patch does not apply", stderr: "" });
      return;
    }
    cb(null, { stdout: "", stderr: "" });
  },
}));

const runTurnMock = vi.fn();
const selectMock = vi.fn();
vi.mock("@oxagen/agent-engine", async (importOriginal) => {
  // Keep the REAL decideSelection (a pure heuristic we exercise, not mock) and
  // everything else; override only the two calls the test drives directly.
  const actual = await importOriginal<typeof import("@oxagen/agent-engine")>();
  return {
    ...actual,
    runTurn: (a: unknown) => runTurnMock(a),
    selectBestCandidate: (a: unknown) => selectMock(a),
    looksPassing: (o: string | undefined) => Boolean(o && !/fail/i.test(o)),
  };
});
// Capture the closure runCandidate hands to createCodeGraphProvider so tests
// can invoke it directly and see which cwd it forwards to queryCodeGraph.
const createCodeGraphProviderMock = vi.fn((fn: unknown) => ({ __fn: fn }));
vi.mock("../adapters/index.js", () => ({
  createCwdWorkspace: vi.fn(() => ({ root: "/wt" })),
  createCodeGraphProvider: (fn: unknown) => createCodeGraphProviderMock(fn),
}));
const queryCodeGraphMock = vi.fn(async (..._args: unknown[]) => "");
vi.mock("../code-graph.js", () => ({ queryCodeGraph: (...a: unknown[]) => queryCodeGraphMock(...a) }));
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
  applyFailuresRemaining = 0;
  runTurnMock.mockReset();
  selectMock.mockReset();
  verifyMock.mockReset().mockResolvedValue({ exitCode: 0, stdout: "2 passed", stderr: "", timedOut: false });
  createCodeGraphProviderMock.mockClear();
  queryCodeGraphMock.mockClear();
});

const ai = { stream: vi.fn(), generateObject: vi.fn() } as unknown as AgentAi;

describe("runBestOfN", () => {
  it("runs N candidates, selects a winner, applies it, and emits the full event stream", async () => {
    // Each candidate turn fires onFileChange with its own diff.
    let call = 0;
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void; onStage?: (s: { label: string }) => void }) => {
      call++;
      // Non-equivalent diffs (same file, DIFFERENT added content) so each gets a
      // distinct consensus fingerprint — proven non-clustering by consensus.test.ts
      // (old2→X vs old2→Y is "selector-needed"). With all three passing this is a
      // genuine tie, which is what routes decideSelection to the LLM selector
      // (the consensus short-circuit is covered by its own test above). Using the
      // real git-diff shape the fingerprinter expects, not a hand-shortened one.
      const foo = (added: string) =>
        `diff --git a/src/foo.ts b/src/foo.ts\nindex 1..2 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,4 +1,4 @@\n line1\n-old2\n+${added}\n line3\n line4`;
      const distinctDiffs = [foo("alpha"), foo("beta"), foo("gamma")];
      const diff = distinctDiffs[(call - 1) % distinctDiffs.length]!;
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

    // The LLM selector actually ran (genuine tie) and its verdict was used —
    // assert the mechanism, not a value the heuristic might coincidentally match.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(result.selection.model).toBe("openai/gpt-4o");
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

  it("perf #6: skips the LLM selector when the executed evidence reaches a consensus", async () => {
    // All candidates converge on the SAME passing diff → a consensus the
    // deterministic heuristic settles for free. The comparative selector (an
    // extra frontier round-trip over N diffs) must NOT be called.
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x.py\n+++ b/x.py\n+same", ["x.py"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });

    const events: BestOfNEvent[] = [];
    const result = await runBestOfN({
      prompt: "fix the bug",
      cwd: "/repo",
      candidates: 3,
      ai,
      verifyCommand: "pytest -q", // all pass (verifyMock → exit 0, "2 passed")
      onEvent: (e) => events.push(e),
    });

    expect(selectMock).not.toHaveBeenCalled();
    // Still resolves and applies a winner via the heuristic.
    expect(result.selection.model).toBe("heuristic");
    expect(result.winner).not.toBeNull();
    expect(events.map((e) => e.type)).toContain("select-done");
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

  it("resolves reasoning effort via resolveEffort — an explicit option wins", async () => {
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 1, ai, effort: "xhigh" });

    expect(runTurnMock.mock.calls[0]![0]).toMatchObject({ effort: "xhigh" });
  });

  it("falls through to OXAGEN_EFFORT when no explicit effort option is given (the env recipe's wiring)", async () => {
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    process.env["OXAGEN_EFFORT"] = "xhigh";
    try {
      await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 1, ai });
      expect(runTurnMock.mock.calls[0]![0]).toMatchObject({ effort: "xhigh" });
    } finally {
      delete process.env["OXAGEN_EFFORT"];
    }
  });

  it("queries the code graph against the shared repo cwd, never the candidate's isolated worktree", async () => {
    // Regression test: candidates used to query queryCodeGraph(wt, ...) — the
    // candidate's own temp worktree path. The persistent DuckDB store keys rows
    // by exact root path, so that path has never been indexed even when the
    // caller pre-built the graph at `cwd` (e.g. via `oxagen init`) — every
    // candidate silently paid a full from-scratch rebuild. Fixed to query
    // opts.cwd instead, reusing whatever was pre-built there.
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 1, ai });

    expect(createCodeGraphProviderMock).toHaveBeenCalledTimes(1);
    const queryFn = createCodeGraphProviderMock.mock.calls[0]![0] as (
      op: string,
      q: string,
      l: number,
    ) => Promise<string>;
    await queryFn("search", "someSymbol", 10);

    expect(queryCodeGraphMock).toHaveBeenCalledWith("/repo", "search", "someSymbol", 10);
    // Never the worktree path (the mocked mkdtemp/join land under /tmp/bestof-xyz/candidate-1).
    expect(queryCodeGraphMock).not.toHaveBeenCalledWith(
      expect.stringContaining("bestof-xyz"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("defaults to bare — no evaluate/enhance/judge, no graph warmup", async () => {
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 1, ai });

    expect(runTurnMock.mock.calls[0]![0]).toMatchObject({
      bare: true,
      enhanceTimeoutMs: undefined,
      midJudgeSteps: undefined,
    });
    // No warmup query fired — nothing will read the code graph in bare mode's
    // ENHANCE-less path until (if ever) the agent's own tool loop asks for it.
    expect(queryCodeGraphMock).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "__graph_warmup__", expect.anything());
  });

  it("fullPipeline: true runs each candidate through evaluate/enhance/judge and warms the shared code graph", async () => {
    // The user explicitly wants pipeline-on + graph-first/semantic engaged
    // for best-of-N, not just the bare engine loop — this opts every
    // candidate into runTurn's full (non-bare) path, mirroring one-shot.ts's
    // headless-mode pipeline defaults (enhanceTimeoutMs, midJudgeSteps).
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({ winnerId: "candidate-1", reasoning: "", ranking: [], model: "m", fallback: false, usage: {} });

    await runBestOfN({ prompt: "explain", cwd: "/repo", candidates: 2, ai, fullPipeline: true });

    expect(runTurnMock).toHaveBeenCalledTimes(2);
    for (const call of runTurnMock.mock.calls) {
      expect(call[0]).toMatchObject({
        bare: false,
        profile: "headless",
        enhanceTimeoutMs: 15_000,
        midJudgeSteps: 20,
      });
    }
    // One shared warmup for opts.cwd — not one per candidate (see comment in
    // runBestOfN: the code-graph cache is keyed by cwd, so a single
    // fire-and-forget call covers the whole race).
    expect(queryCodeGraphMock).toHaveBeenCalledWith("/repo", "search", "__graph_warmup__", 1);
  });

  it("keeps every candidate's worktree alive through selection, removing them only after", async () => {
    // P1: worktree cleanup used to happen in runCandidate's own `finally`,
    // before selection ever ran. Assert the inverse now holds: at the moment
    // selection COMPLETES (the `select-done` event), nothing has been removed
    // yet — the worktrees must survive the whole race; only once selection +
    // apply are done are all 3 cleaned up. Observing `select-done` (not the LLM
    // selector) keeps this robust whether selection took the deterministic
    // heuristic short-circuit or the comparative selector.
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });

    let removedAtSelectDone = -1;
    await runBestOfN({
      prompt: "explain",
      cwd: "/repo",
      candidates: 3,
      ai,
      onEvent: (e) => {
        if (e.type === "select-done") {
          removedAtSelectDone = gitCalls.filter((a) => a[0] === "worktree" && a[1] === "remove").length;
        }
      },
    });

    expect(removedAtSelectDone).toBe(0);
    expect(gitCalls.filter((a) => a[0] === "worktree" && a[1] === "add")).toHaveLength(3);
    expect(gitCalls.filter((a) => a[0] === "worktree" && a[1] === "remove")).toHaveLength(3);
  });

  it("verifyAuto unions the test commands every candidate ran and re-runs the union in EVERY surviving worktree", async () => {
    // candidate-1 runs `pytest -q` on its own turn; candidate-2 runs
    // `vitest run`; neither runs both — verifyAuto should still exercise
    // BOTH commands in BOTH worktrees before selection.
    let call = 0;
    runTurnMock.mockImplementation(
      async (o: {
        onFileChange?: (d: string, f: string[]) => void;
        onToolCall?: (name: string, input: unknown) => void;
      }) => {
        call++;
        const cmd = call === 1 ? "pytest -q" : "vitest run";
        o.onToolCall?.("bash", { command: cmd });
        o.onFileChange?.(`--- a/x\n+++ b/x\n+c${call}`, ["x"]);
        return { text: `candidate ${call}`, steps: 2, messages: [], usage: {}, trace: {} };
      },
    );
    selectMock.mockResolvedValue({
      winnerId: "candidate-1",
      reasoning: "",
      ranking: [
        { id: "candidate-1", score: 90, note: "ok" },
        { id: "candidate-2", score: 80, note: "ok" },
      ],
      model: "m",
      fallback: false,
      usage: {},
    });
    verifyMock.mockResolvedValue({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false });

    const result = await runBestOfN({ prompt: "fix", cwd: "/repo", candidates: 2, ai, verifyAuto: true });

    // 2 candidates x 2 unioned commands = 4 verification runs, not 2.
    expect(verifyMock).toHaveBeenCalledTimes(4);
    const calls = verifyMock.mock.calls as Array<[{ command: string; cwd: string }]>;
    const commands = calls.map(([c]) => c.command).sort();
    expect(commands).toEqual(["pytest -q", "pytest -q", "vitest run", "vitest run"]);
    // Every command ran against BOTH candidates' worktrees (2 distinct cwds).
    const cwdsPerCommand = new Map<string, Set<string>>();
    for (const [c] of calls) {
      if (!cwdsPerCommand.has(c.command)) cwdsPerCommand.set(c.command, new Set());
      cwdsPerCommand.get(c.command)!.add(c.cwd);
    }
    expect(cwdsPerCommand.get("pytest -q")?.size).toBe(2);
    expect(cwdsPerCommand.get("vitest run")?.size).toBe(2);

    // The decisive testsPassed signal reached both candidates.
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.testsPassed === true)).toBe(true);
    expect(result.candidates.every((c) => c.testOutput?.includes("PASS"))).toBe(true);
  });

  it("verifyAuto ignores non-test commands (e.g. an install or an rm) — never replays them across worktrees", async () => {
    runTurnMock.mockImplementation(
      async (o: {
        onFileChange?: (d: string, f: string[]) => void;
        onToolCall?: (name: string, input: unknown) => void;
      }) => {
        o.onToolCall?.("bash", { command: "rm -rf node_modules && npm install" });
        o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
        return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
      },
    );
    selectMock.mockResolvedValue({
      winnerId: "candidate-1",
      reasoning: "",
      ranking: [{ id: "candidate-1", score: 90, note: "ok" }],
      model: "m",
      fallback: false,
      usage: {},
    });

    await runBestOfN({ prompt: "fix", cwd: "/repo", candidates: 1, ai, verifyAuto: true });

    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("falls back to the next-ranked candidate's diff when the winner's patch fails to apply", async () => {
    let call = 0;
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      call++;
      o.onFileChange?.(`--- a/x\n+++ b/x\n+c${call}`, ["x"]);
      return { text: `candidate ${call}`, steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({
      winnerId: "candidate-1",
      reasoning: "candidate-1 looked best",
      ranking: [
        { id: "candidate-1", score: 90, note: "best" },
        { id: "candidate-2", score: 70, note: "second" },
      ],
      model: "m",
      fallback: false,
      usage: {},
    });
    // The winner's (candidate-1's) `git apply` rejects; the fallback attempt
    // (candidate-2's diff) must succeed.
    applyFailuresRemaining = 1;

    const events: BestOfNEvent[] = [];
    const result = await runBestOfN({ prompt: "fix", cwd: "/repo", candidates: 2, ai, onEvent: (e) => events.push(e) });

    // Exactly 2 apply attempts (winner rejected, fallback accepted).
    expect(gitCalls.filter((a) => a[0] === "apply")).toHaveLength(2);
    // No apply-failed event — the fallback recovered the race.
    expect(events.some((e) => e.type === "apply-failed")).toBe(false);
    const applied = events.find((e) => e.type === "applied");
    expect(applied).toMatchObject({ winnerId: "candidate-2" });
    // The result's winner reflects who ACTUALLY got applied, not the
    // selector's original (superseded) pick.
    expect(result.winner?.id).toBe("candidate-2");
    // selection.winnerId still records the selector's original verdict.
    expect(result.selection.winnerId).toBe("candidate-1");
  });

  it("emits apply-failed only when EVERY ranked candidate's diff fails to apply", async () => {
    runTurnMock.mockImplementation(async (o: { onFileChange?: (d: string, f: string[]) => void }) => {
      o.onFileChange?.("--- a/x\n+++ b/x\n+z", ["x"]);
      return { text: "ok", steps: 1, messages: [], usage: {}, trace: {} };
    });
    selectMock.mockResolvedValue({
      winnerId: "candidate-1",
      reasoning: "",
      ranking: [{ id: "candidate-1", score: 90, note: "ok" }],
      model: "m",
      fallback: false,
      usage: {},
    });
    applyFailuresRemaining = 99; // every apply attempt fails

    const events: BestOfNEvent[] = [];
    const result = await runBestOfN({ prompt: "fix", cwd: "/repo", candidates: 1, ai, onEvent: (e) => events.push(e) });

    expect(events.some((e) => e.type === "apply-failed")).toBe(true);
    expect(events.some((e) => e.type === "applied")).toBe(false);
    // Falls back to the selector's original pick when nothing actually applied.
    expect(result.winner?.id).toBe("candidate-1");
  });
});
