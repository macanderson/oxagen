import { describe, it, expect, afterEach } from "vitest";
import {
  resolveBestOfNMode,
  rewriteCommandForWorktree,
  looksTruncatedCommand,
  routeSelection,
  forkTailModel,
} from "./best-of-n.js";
import { DEFAULT_CODING_MODEL } from "./model-catalog.js";
import type { Candidate, SelectionDecision } from "@oxagen/agent-engine";

describe("forkTailModel", () => {
  it("pins the CLI default coding model when --models is unset", () => {
    expect(forkTailModel(undefined, 0)).toBe(DEFAULT_CODING_MODEL);
    expect(forkTailModel([], 2)).toBe(DEFAULT_CODING_MODEL);
  });

  it("rotates through an explicit model list", () => {
    const models = ["anthropic/claude-fable-5", "openai/gpt-5.5-pro"];
    expect(forkTailModel(models, 0)).toBe("anthropic/claude-fable-5");
    expect(forkTailModel(models, 1)).toBe("openai/gpt-5.5-pro");
    expect(forkTailModel(models, 2)).toBe("anthropic/claude-fable-5");
  });

  it("never returns undefined (would fall through to the engine frontier fallback)", () => {
    // A sparse entry must still resolve to the default, not undefined.
    expect(forkTailModel([undefined as unknown as string], 0)).toBe(
      DEFAULT_CODING_MODEL,
    );
  });
});

describe("resolveBestOfNMode", () => {
  const originalEnv = process.env.OXAGEN_BEST_OF_N_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OXAGEN_BEST_OF_N_MODE = originalEnv;
    } else {
      delete process.env.OXAGEN_BEST_OF_N_MODE;
    }
  });

  it("returns explicit mode when provided", () => {
    delete process.env.OXAGEN_BEST_OF_N_MODE;
    expect(resolveBestOfNMode("fork")).toBe("fork");
    expect(resolveBestOfNMode("independent")).toBe("independent");
  });

  it("resolves from OXAGEN_BEST_OF_N_MODE env when set", () => {
    process.env.OXAGEN_BEST_OF_N_MODE = "fork";
    expect(resolveBestOfNMode()).toBe("fork");

    process.env.OXAGEN_BEST_OF_N_MODE = "independent";
    expect(resolveBestOfNMode()).toBe("independent");
  });

  it("defaults to 'independent' when env is unset", () => {
    delete process.env.OXAGEN_BEST_OF_N_MODE;
    expect(resolveBestOfNMode()).toBe("independent");
  });

  it("defaults to 'independent' when env has invalid value", () => {
    process.env.OXAGEN_BEST_OF_N_MODE = "invalid";
    expect(resolveBestOfNMode()).toBe("independent");

    process.env.OXAGEN_BEST_OF_N_MODE = "";
    expect(resolveBestOfNMode()).toBe("independent");
  });

  it("prefers explicit mode over env", () => {
    process.env.OXAGEN_BEST_OF_N_MODE = "independent";
    expect(resolveBestOfNMode("fork")).toBe("fork");
  });
});

describe("rewriteCommandForWorktree", () => {
  const wt = "/tmp/oxagen-bestof-abc/candidate-1";

  it("rewrites a `cd <repoRoot>` prefix so the replay stays inside the worktree", () => {
    expect(
      rewriteCommandForWorktree(
        "cd /testbed && python -m pytest -q",
        "/testbed",
        wt,
      ),
    ).toBe(`cd ${wt} && python -m pytest -q`);
  });

  it("rewrites a `cd <repoRoot>/<sub>` prefix into the worktree's subdir", () => {
    expect(
      rewriteCommandForWorktree(
        "cd /testbed/tests && pytest .",
        "/testbed",
        wt,
      ),
    ).toBe(`cd ${wt}/tests && pytest .`);
  });

  it("rewrites mid-string absolute paths into the repo", () => {
    expect(
      rewriteCommandForWorktree(
        "python -m pytest /testbed/tests/test_x.py -x",
        "/testbed",
        wt,
      ),
    ).toBe(`python -m pytest ${wt}/tests/test_x.py -x`);
  });

  it("rewrites every occurrence, including after `=` and inside quotes", () => {
    expect(
      rewriteCommandForWorktree(
        'pytest --rootdir=/testbed "/testbed/tests"',
        "/testbed",
        wt,
      ),
    ).toBe(`pytest --rootdir=${wt} "${wt}/tests"`);
  });

  it("leaves /tmp and other out-of-repo paths untouched", () => {
    const cmd = "pytest --basetemp=/tmp/pytest-run /testbed/tests";
    expect(rewriteCommandForWorktree(cmd, "/testbed", wt)).toBe(
      `pytest --basetemp=/tmp/pytest-run ${wt}/tests`,
    );
  });

  it("does NOT rewrite sibling paths that merely share the prefix (/testbed2, /testbed.bak, /testbed-old)", () => {
    const cmd = "ls /testbed2 /testbed.bak /testbed-old";
    expect(rewriteCommandForWorktree(cmd, "/testbed", wt)).toBe(cmd);
  });

  it("does NOT rewrite when the repo root appears as a nested path segment (/opt/testbed)", () => {
    const cmd = "cat /opt/testbed/config";
    expect(rewriteCommandForWorktree(cmd, "/testbed", wt)).toBe(cmd);
  });

  it("returns the command unchanged when the repo root never appears", () => {
    expect(rewriteCommandForWorktree("pytest -q", "/testbed", wt)).toBe(
      "pytest -q",
    );
  });

  it("tolerates a trailing slash on the repo root", () => {
    expect(
      rewriteCommandForWorktree("cd /testbed && pytest", "/testbed/", wt),
    ).toBe(`cd ${wt} && pytest`);
  });

  it("never rewrites for a degenerate root of '/' or empty string", () => {
    expect(rewriteCommandForWorktree("cd /x && pytest", "/", wt)).toBe(
      "cd /x && pytest",
    );
    expect(rewriteCommandForWorktree("cd /x && pytest", "", wt)).toBe(
      "cd /x && pytest",
    );
  });

  it("escapes regex metacharacters in the repo root path", () => {
    expect(
      rewriteCommandForWorktree(
        "cd /repo (main) && pytest",
        "/repo (main)",
        wt,
      ),
    ).toBe(`cd ${wt} && pytest`);
  });
});

describe("looksTruncatedCommand", () => {
  it("flags the engine's 120-char-capped `…` suffix", () => {
    expect(
      looksTruncatedCommand("python -m pytest tests/some/very/long/path…"),
    ).toBe(true);
  });

  it("accepts full commands, including ones legitimately longer than the cap", () => {
    expect(looksTruncatedCommand("pytest -q")).toBe(false);
    expect(
      looksTruncatedCommand(`python -m pytest ${"tests/x ".repeat(30)}-x`),
    ).toBe(false);
  });
});

describe("routeSelection", () => {
  const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
    id,
    model: "m",
    diff: `--- a/x\n+++ b/x\n+${id}`,
    summary: "s",
    changedFiles: ["x"],
    steps: 1,
    ...over,
  });

  it("routes selector-needed decisions to the selector with the passing subset", () => {
    const cands = [
      candidate("candidate-1"),
      candidate("candidate-2"),
      candidate("candidate-3"),
    ];
    const decision: SelectionDecision = {
      method: "selector-needed",
      candidates: [0, 2],
    };
    const route = routeSelection(decision, cands, true);
    expect(route.useSelector).toBe(true);
    expect(route.pool.map((c) => c.id)).toEqual(["candidate-1", "candidate-3"]);
    expect(route.warning).toBeUndefined();
  });

  it("routes to the selector with a warning when verify-auto yielded no evidence for anyone", () => {
    const cands = [
      candidate("candidate-1", { testsPassed: null }),
      candidate("candidate-2", { testsPassed: undefined }),
    ];
    const decision: SelectionDecision = { method: "best-effort", winner: 0 };
    const route = routeSelection(decision, cands, true);
    expect(route.useSelector).toBe(true);
    expect(route.pool.map((c) => c.id)).toEqual(["candidate-1", "candidate-2"]);
    expect(route.warning).toMatch(/no executed test evidence/i);
  });

  it("excludes failed and empty-diff candidates from the no-evidence selector pool", () => {
    const cands = [
      candidate("candidate-1"),
      candidate("candidate-2", { failed: true }),
      candidate("candidate-3", { diff: "   " }),
      candidate("candidate-4"),
    ];
    const decision: SelectionDecision = { method: "best-effort", winner: 0 };
    const route = routeSelection(decision, cands, true);
    expect(route.useSelector).toBe(true);
    expect(route.pool.map((c) => c.id)).toEqual(["candidate-1", "candidate-4"]);
  });

  it("keeps the heuristic when fewer than 2 candidates are comparable (nothing for a selector to compare)", () => {
    const cands = [
      candidate("candidate-1"),
      candidate("candidate-2", { diff: "" }),
    ];
    const decision: SelectionDecision = { method: "best-effort", winner: 0 };
    expect(routeSelection(decision, cands, true).useSelector).toBe(false);
  });

  it("keeps best-effort when evidence exists and genuinely says every candidate fails", () => {
    const cands = [
      candidate("candidate-1", { testsPassed: false }),
      candidate("candidate-2", { testsPassed: false }),
    ];
    const decision: SelectionDecision = { method: "best-effort", winner: 0 };
    const route = routeSelection(decision, cands, true);
    expect(route.useSelector).toBe(false);
    expect(route.warning).toBeUndefined();
  });

  it("keeps the heuristic when verify-auto was off, even with no evidence", () => {
    const cands = [candidate("candidate-1"), candidate("candidate-2")];
    const decision: SelectionDecision = { method: "best-effort", winner: 0 };
    expect(routeSelection(decision, cands, false).useSelector).toBe(false);
  });

  it("never overrides consensus or single-passing decisions", () => {
    const cands = [
      candidate("candidate-1", { testsPassed: true }),
      candidate("candidate-2", { testsPassed: true }),
    ];
    const consensus: SelectionDecision = {
      method: "consensus",
      winner: 0,
      cluster: [0, 1],
    };
    expect(routeSelection(consensus, cands, true).useSelector).toBe(false);
    const single: SelectionDecision = { method: "single-passing", winner: 1 };
    expect(routeSelection(single, cands, true).useSelector).toBe(false);
  });
});
