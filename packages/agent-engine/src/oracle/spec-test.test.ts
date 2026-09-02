import { describe, it, expect } from "vitest";
import {
  isTestLikeCommand,
  createSpecTestTracker,
  type OracleState,
} from "./spec-test";

describe("isTestLikeCommand", () => {
  describe("matches test runners", () => {
    it("matches pytest variants", () => {
      expect(isTestLikeCommand("pytest")).toBe(true);
      expect(isTestLikeCommand("py.test")).toBe(true);
      expect(isTestLikeCommand("python -m pytest test.py")).toBe(true);
      expect(isTestLikeCommand("pytest tests/ -v")).toBe(true);
    });

    it("matches unittest variants", () => {
      expect(isTestLikeCommand("unittest")).toBe(true);
      expect(isTestLikeCommand("python -m unittest discover")).toBe(true);
      expect(isTestLikeCommand("python -m unittest tests.test_foo")).toBe(true);
    });

    it("matches nose variants", () => {
      expect(isTestLikeCommand("nose")).toBe(true);
      expect(isTestLikeCommand("nose2")).toBe(true);
    });

    it("matches tox", () => {
      expect(isTestLikeCommand("tox")).toBe(true);
      expect(isTestLikeCommand("tox -e py39")).toBe(true);
    });

    it("matches Node.js test runners", () => {
      expect(isTestLikeCommand("jest")).toBe(true);
      expect(isTestLikeCommand("vitest")).toBe(true);
      expect(isTestLikeCommand("mocha")).toBe(true);
      expect(isTestLikeCommand("mocha tests/")).toBe(true);
      expect(isTestLikeCommand("npm test")).toBe(true);
      expect(isTestLikeCommand("npm run test")).toBe(true);
      expect(isTestLikeCommand("pnpm test")).toBe(true);
      expect(isTestLikeCommand("pnpm test:unit")).toBe(true);
      expect(
        isTestLikeCommand("pnpm --filter @oxagen/agent-engine test:unit"),
      ).toBe(true);
      expect(isTestLikeCommand("yarn test")).toBe(true);
    });

    it("matches Go test", () => {
      expect(isTestLikeCommand("go test")).toBe(true);
      expect(isTestLikeCommand("go test ./...")).toBe(true);
    });

    it("matches Cargo test", () => {
      expect(isTestLikeCommand("cargo test")).toBe(true);
      expect(isTestLikeCommand("cargo test --lib")).toBe(true);
    });

    it("matches runtests.py", () => {
      expect(isTestLikeCommand("python runtests.py")).toBe(true);
      expect(isTestLikeCommand("./runtests.py")).toBe(true);
      expect(isTestLikeCommand("path/to/runtests.py")).toBe(true);
    });

    it("matches scratch-dir script execution", () => {
      expect(isTestLikeCommand(".oxagen/scratch/test.py")).toBe(true);
      expect(isTestLikeCommand("python .oxagen/scratch/repro.py")).toBe(true);
      expect(isTestLikeCommand("bash .oxagen/scratch/check.sh")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isTestLikeCommand("PYTEST")).toBe(true);
      expect(isTestLikeCommand("PyTest tests/")).toBe(true);
      expect(isTestLikeCommand("VITEST")).toBe(true);
      expect(isTestLikeCommand("Go Test")).toBe(true);
    });

    it("matches word boundaries correctly", () => {
      // 'test' is in many words; we match only word-boundary variants
      expect(isTestLikeCommand("npm test")).toBe(true);
      expect(isTestLikeCommand("pytest")).toBe(true);
      // 'test' in the middle of a non-test command should not match
      // (though "testing" or "pytest" would still match due to word boundary)
      expect(isTestLikeCommand("cat testfile.txt")).toBe(false);
    });
  });

  describe("does NOT match non-test commands", () => {
    it("rejects plain builds and installs", () => {
      expect(isTestLikeCommand("npm install")).toBe(false);
      expect(isTestLikeCommand("pnpm install")).toBe(false);
      expect(isTestLikeCommand("pip install -e .")).toBe(false);
      expect(isTestLikeCommand("cargo build")).toBe(false);
      expect(isTestLikeCommand("go build")).toBe(false);
    });

    it("rejects linters", () => {
      expect(isTestLikeCommand("eslint src/")).toBe(false);
      expect(isTestLikeCommand("ruff check .")).toBe(false);
      expect(isTestLikeCommand("flake8 src/")).toBe(false);
      expect(isTestLikeCommand("pylint src/")).toBe(false);
    });

    it("rejects grep and other utilities", () => {
      expect(isTestLikeCommand("grep -r 'pattern' src/")).toBe(false);
      expect(isTestLikeCommand("cat file.txt")).toBe(false);
      expect(isTestLikeCommand("ls -la")).toBe(false);
    });

    it("rejects plain npm/yarn/pnpm without test", () => {
      expect(isTestLikeCommand("npm run build")).toBe(false);
      expect(isTestLikeCommand("yarn build")).toBe(false);
      expect(isTestLikeCommand("pnpm build")).toBe(false);
    });
  });

  describe("handles whitespace", () => {
    it("ignores leading/trailing whitespace", () => {
      expect(isTestLikeCommand("  pytest  ")).toBe(true);
      expect(isTestLikeCommand("\tvitest\t")).toBe(true);
    });
  });
});

describe("SpecTestTracker", () => {
  describe("state transitions", () => {
    it("starts in 'none' state", () => {
      const tracker = createSpecTestTracker();
      expect(tracker.state()).toBe("none");
      expect(tracker.flippedBy()).toBe(null);
    });

    it("transitions 'none' → 'failing' on first failing test", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
    });

    it("stays in 'none' when only passing tests are observed", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("none");
    });

    it("transitions 'failing' → 'flipped' when same command passes after failing", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      expect(tracker.flippedBy()).toBe("pytest");
    });

    it("stays 'flipped' even if other commands fail afterwards", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      tracker.observe({ command: "npm test", exitCode: 1 });
      expect(tracker.state()).toBe("flipped");
    });

    it("stays 'failing' if a different command passes", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "npm test", exitCode: 0 });
      // Different command passing doesn't flip the oracle.
      expect(tracker.state()).toBe("failing");
    });

    it("flips on the specific command that previously failed", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest tests/", exitCode: 1 });
      tracker.observe({ command: "npm test", exitCode: 0 });
      // npm test passing doesn't flip because pytest is the one that failed.
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "pytest tests/", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      expect(tracker.flippedBy()).toBe("pytest tests/");
    });
  });

  describe("command normalization", () => {
    it("normalizes whitespace variants to the same command", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest  tests/", exitCode: 1 });
      tracker.observe({ command: "pytest tests/", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
    });

    it("normalizes leading/trailing whitespace", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "  pytest  ", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
    });

    it("collapses multiple internal spaces", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({
        command: "pnpm   --filter   @oxagen/agent-engine   test:unit",
        exitCode: 1,
      });
      tracker.observe({
        command: "pnpm --filter @oxagen/agent-engine test:unit",
        exitCode: 0,
      });
      expect(tracker.state()).toBe("flipped");
    });

    it("preserves command identity through tabs and mixed whitespace", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest\ttests/\n", exitCode: 1 });
      tracker.observe({ command: "pytest tests/", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
    });
  });

  describe("test command tracking", () => {
    it("ignores non-test commands", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "npm install", exitCode: 0 });
      tracker.observe({ command: "eslint src/", exitCode: 0 });
      tracker.observe({ command: "cat file.txt", exitCode: 0 });
      expect(tracker.testCommands()).toEqual([]);
    });

    it("tracks distinct test commands in insertion order", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 0 });
      tracker.observe({ command: "npm test", exitCode: 0 });
      tracker.observe({ command: "vitest", exitCode: 0 });
      expect(tracker.testCommands()).toEqual(["pytest", "npm test", "vitest"]);
    });

    it("deduplicates commands (same normalized form)", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.testCommands()).toEqual(["pytest"]);
    });

    it("deduplicates whitespace variants", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest  tests/", exitCode: 1 });
      tracker.observe({ command: "pytest tests/", exitCode: 0 });
      expect(tracker.testCommands()).toEqual(["pytest tests/"]);
    });

    it("preserves insertion order with multiple commands", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "npm install", exitCode: 0 }); // ignored
      tracker.observe({ command: "npm test", exitCode: 0 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      tracker.observe({ command: "vitest", exitCode: 1 });
      expect(tracker.testCommands()).toEqual(["pytest", "npm test", "vitest"]);
    });
  });

  describe("flaky behavior (fail → fail → pass)", () => {
    it("flips when a flaky command eventually passes", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      expect(tracker.flippedBy()).toBe("pytest");
    });

    it("flips on the first pass after any failures", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
    });
  });

  describe("scratch-dir script execution", () => {
    it("counts .oxagen/scratch/ scripts as test-like", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: ".oxagen/scratch/repro.py", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: ".oxagen/scratch/repro.py", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      expect(tracker.testCommands()).toEqual([".oxagen/scratch/repro.py"]);
    });

    it("normalizes paths in scratch scripts", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({
        command: "python  .oxagen/scratch/check.py",
        exitCode: 1,
      });
      tracker.observe({
        command: "python .oxagen/scratch/check.py",
        exitCode: 0,
      });
      expect(tracker.state()).toBe("flipped");
    });
  });

  describe("lastOutcomes()", () => {
    it("returns empty map when no commands observed", () => {
      const tracker = createSpecTestTracker();
      expect(tracker.lastOutcomes().size).toBe(0);
    });

    it("returns most recent exit codes for each distinct command", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "npm test", exitCode: 0 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      const outcomes = tracker.lastOutcomes();
      expect(outcomes.get("pytest")).toBe(0);
      expect(outcomes.get("npm test")).toBe(0);
    });

    it("tracks multiple different outcomes independently", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "npm test", exitCode: 1 });
      tracker.observe({ command: "vitest", exitCode: 0 });
      const outcomes = tracker.lastOutcomes();
      expect(outcomes.get("pytest")).toBe(1);
      expect(outcomes.get("npm test")).toBe(1);
      expect(outcomes.get("vitest")).toBe(0);
    });

    it("ignores non-test commands", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "npm install", exitCode: 0 });
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "eslint src/", exitCode: 0 });
      const outcomes = tracker.lastOutcomes();
      expect(outcomes.size).toBe(1);
      expect(outcomes.get("pytest")).toBe(1);
    });

    it("returns a copy, not the internal map", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      const outcomes1 = tracker.lastOutcomes();
      outcomes1.set("pytest", 999);
      const outcomes2 = tracker.lastOutcomes();
      expect(outcomes2.get("pytest")).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles exitCode 0 as success, non-zero as failure", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 127 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
    });

    it("handles multiple test commands with different outcomes", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "npm test", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      tracker.observe({ command: "npm test", exitCode: 0 });
      // npm test went fail→pass: any same-command flip advances the oracle,
      // regardless of other still-failing commands.
      expect(tracker.state()).toBe("flipped");
      expect(tracker.flippedBy()).toBe("npm test");
    });

    it("flippedBy() returns the specific command that flipped", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({
        command: "pnpm --filter @oxagen/agent-engine test:unit",
        exitCode: 1,
      });
      tracker.observe({
        command: "pnpm --filter @oxagen/agent-engine test:unit",
        exitCode: 0,
      });
      expect(tracker.flippedBy()).toBe(
        "pnpm --filter @oxagen/agent-engine test:unit",
      );
    });

    it("flippedBy() returns null before flip", () => {
      const tracker = createSpecTestTracker();
      expect(tracker.flippedBy()).toBe(null);
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.flippedBy()).toBe(null);
    });

    it("flippedBy() stays constant after flip", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      const flipped = tracker.flippedBy();
      tracker.observe({ command: "npm test", exitCode: 1 });
      expect(tracker.flippedBy()).toBe(flipped);
    });
  });

  describe("integration scenarios", () => {
    it("scenario: never-run → 'none'", () => {
      const tracker = createSpecTestTracker();
      expect(tracker.state()).toBe("none");
      expect(tracker.testCommands()).toEqual([]);
    });

    it("scenario: pass-only → 'none'", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 0 });
      tracker.observe({ command: "npm test", exitCode: 0 });
      expect(tracker.state()).toBe("none");
      expect(tracker.testCommands()).toEqual(["pytest", "npm test"]);
    });

    it("scenario: fail-only → 'failing'", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      expect(tracker.state()).toBe("failing");
      expect(tracker.testCommands()).toEqual(["pytest"]);
    });

    it("scenario: fail A then pass B (different commands) → still 'failing'", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "npm test", exitCode: 0 });
      expect(tracker.state()).toBe("failing");
      expect(tracker.testCommands()).toEqual(["pytest", "npm test"]);
    });

    it("scenario: mixed non-test and test commands", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "npm install", exitCode: 0 }); // ignored
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "eslint src/", exitCode: 0 }); // ignored
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      expect(tracker.testCommands()).toEqual(["pytest"]);
    });

    it("scenario: post-flip failure of another command stays 'flipped'", () => {
      const tracker = createSpecTestTracker();
      tracker.observe({ command: "pytest", exitCode: 1 });
      tracker.observe({ command: "pytest", exitCode: 0 });
      expect(tracker.state()).toBe("flipped");
      tracker.observe({ command: "npm test", exitCode: 1 });
      tracker.observe({ command: "npm test", exitCode: 1 });
      expect(tracker.state()).toBe("flipped");
    });
  });
});
