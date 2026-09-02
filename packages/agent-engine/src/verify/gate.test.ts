/**
 * Mutation verifier — gate orchestration (I/O against the Workspace port).
 *
 * Uses a purpose-built fake workspace whose exec handler can SEE the reverted
 * file contents, so the tests prove the property that matters: the witness
 * command runs against the fix-REVERTED tree (witnessed/vacuous verdicts), and
 * the tree is byte-identical to its pre-gate state afterwards — including when
 * the gate throws, aborts, or scores mutants.
 */
import { describe, it, expect, vi } from "vitest";
import type { CommandResult, Workspace } from "../types";
import { runMutationGate } from "./gate";
import type { TestEvidence } from "./mutation";

// ── Fake workspace ─────────────────────────────────────────────────────────────

class FakeWorkspace implements Workspace {
  readonly root = "/repo";
  files = new Map<string, string>();
  execLog: string[] = [];
  onExec: (cmd: string) => CommandResult = () => ok(0);
  /** When set, writeFile throws for these paths (restore-failure injection). */
  failWritesFor = new Set<string>();
  /** One-shot: writeFile throws ONCE per path, then succeeds (revert-failure injection). */
  failNextWriteFor = new Set<string>();

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }
  async readFile(p: string): Promise<string> {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`ENOENT: ${p}`);
    return t;
  }
  async writeFile(p: string, content: string): Promise<void> {
    if (this.failWritesFor.has(p)) throw new Error(`EACCES: ${p}`);
    if (this.failNextWriteFor.delete(p)) throw new Error(`EIO once: ${p}`);
    this.files.set(p, content);
  }
  async editFile(): Promise<number> {
    throw new Error("not used");
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async glob(): Promise<string[]> {
    return [];
  }
  async grep(): Promise<string[]> {
    return [];
  }
  async exec(command: string): Promise<CommandResult> {
    this.execLog.push(command);
    // `rm` is how the gate deletes files (the port has no unlink).
    const rm = /^rm -- '(.+)'$/.exec(command);
    if (rm) {
      this.files.delete(rm[1]!.replace(/'\\''/g, "'"));
      return ok(0);
    }
    return this.onExec(command);
  }
  async diff(): Promise<string> {
    return "";
  }
}

function ok(exitCode: number, timedOut = false): CommandResult {
  return { exitCode, stdout: "", stderr: "", timedOut };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const FIXED = "export const answer = () => 42;\n";
const ORIGINAL = "export const answer = () => 41;\n";
const TEST_FILE =
  "import { answer } from './calc';\ntest('answer', () => {});\n";

const DIFF = [
  "diff --git a/src/calc.ts b/src/calc.ts",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -1 +1 @@",
  "-export const answer = () => 41;",
  "+export const answer = () => 42;",
  "diff --git a/src/calc.test.ts b/src/calc.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/calc.test.ts",
  "@@ -0,0 +1,2 @@",
  "+import { answer } from './calc';",
  "+test('answer', () => {});",
].join("\n");

const WITNESS = "pnpm vitest run src/calc.test.ts";

function evidence(flipped = true): TestEvidence {
  return {
    lastOutcomes: new Map([[WITNESS, 0]]),
    flippedBy: flipped ? WITNESS : null,
  };
}

function workspace(): FakeWorkspace {
  return new FakeWorkspace({
    "src/calc.ts": FIXED,
    "src/calc.test.ts": TEST_FILE,
  });
}

// ── Layer 1: witnessed / vacuous ───────────────────────────────────────────────

describe("runMutationGate — layer 1", () => {
  it("is witnessed when the test fails against the reverted fix, then restores", async () => {
    const ws = workspace();
    const seen: string[] = [];
    ws.onExec = (cmd) => {
      if (cmd === WITNESS) {
        seen.push(ws.files.get("src/calc.ts")!);
        // The witness runs against the PRE-FIX content ⇒ it fails.
        return ws.files.get("src/calc.ts") === ORIGINAL ? ok(1) : ok(0);
      }
      return ok(0);
    };
    const onStart = vi.fn();
    const result = await runMutationGate(ws, DIFF, evidence(), { onStart });

    expect(result.status).toBe("witnessed");
    expect(result.runs).toEqual([
      { command: WITNESS, exitCode: 1, timedOut: false },
    ]);
    expect(result.revertedFiles).toEqual(["src/calc.ts"]);
    expect(result.testFiles).toEqual(["src/calc.test.ts"]);
    // The witness really saw the reverted tree…
    expect(seen).toEqual([ORIGINAL]);
    // …and the fix is back, test file untouched.
    expect(ws.files.get("src/calc.ts")).toBe(FIXED);
    expect(ws.files.get("src/calc.test.ts")).toBe(TEST_FILE);
    expect(onStart).toHaveBeenCalledWith({
      commands: [WITNESS],
      revertedFiles: ["src/calc.ts"],
    });
  });

  it("is vacuous when the test still passes without the fix", async () => {
    const ws = workspace();
    ws.onExec = () => ok(0); // green no matter what — the test witnesses nothing
    const result = await runMutationGate(ws, DIFF, evidence());
    expect(result.status).toBe("vacuous");
    expect(result.reason).toContain("do not witness");
    expect(ws.files.get("src/calc.ts")).toBe(FIXED);
  });

  it("counts a timed-out witness run as a failure (witnessed)", async () => {
    const ws = workspace();
    ws.onExec = (cmd) => (cmd === WITNESS ? ok(0, true) : ok(0));
    const result = await runMutationGate(ws, DIFF, evidence());
    expect(result.status).toBe("witnessed");
    expect(result.runs[0]).toEqual({
      command: WITNESS,
      exitCode: null,
      timedOut: true,
    });
  });

  it("reverts and restores a fix spanning MULTIPLE source files", async () => {
    const multiDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const b = 1;",
      "+export const b = 2;",
      "diff --git a/src/ab.test.ts b/src/ab.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/ab.test.ts",
      "@@ -0,0 +1 @@",
      "+import './a'; import './b';",
    ].join("\n");
    const ws = new FakeWorkspace({
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/ab.test.ts": "import './a'; import './b';\n",
    });
    const seen: Array<[string, string]> = [];
    ws.onExec = (cmd) => {
      if (cmd !== WITNESS) return ok(0);
      seen.push([ws.files.get("src/a.ts")!, ws.files.get("src/b.ts")!]);
      const bothReverted =
        ws.files.get("src/a.ts") === "export const a = 1;\n" &&
        ws.files.get("src/b.ts") === "export const b = 1;\n";
      return bothReverted ? ok(1) : ok(0);
    };
    const result = await runMutationGate(ws, multiDiff, evidence());
    expect(result.status).toBe("witnessed");
    expect(result.revertedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    // The witness saw BOTH files reverted at once…
    expect(seen).toEqual([["export const a = 1;\n", "export const b = 1;\n"]]);
    // …and BOTH are byte-for-byte restored, test file untouched.
    expect(ws.files.get("src/a.ts")).toBe("export const a = 2;\n");
    expect(ws.files.get("src/b.ts")).toBe("export const b = 2;\n");
    expect(ws.files.get("src/ab.test.ts")).toBe(
      "import './a'; import './b';\n",
    );
  });

  it("reverts a fix that DELETED a source file by recreating it, then removes it again", async () => {
    const deletedDiff = [
      "diff --git a/src/legacy.ts b/src/legacy.ts",
      "deleted file mode 100644",
      "--- a/src/legacy.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const legacy = true;",
      "-export const gone = 1;",
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/legacy.test.ts",
      "@@ -0,0 +1 @@",
      "+import './calc';",
    ].join("\n");
    const ORIGINAL_LEGACY =
      "export const legacy = true;\nexport const gone = 1;\n";
    // The fix deleted src/legacy.ts, so it is ABSENT from the current tree.
    const ws = new FakeWorkspace({
      "src/legacy.test.ts": "import './calc';\n",
    });
    const seen: Array<string | undefined> = [];
    ws.onExec = (cmd) => {
      if (cmd !== WITNESS) return ok(0);
      seen.push(ws.files.get("src/legacy.ts"));
      // The shadow recreated the pre-fix file ⇒ the test fails without the fix.
      return ws.files.get("src/legacy.ts") === ORIGINAL_LEGACY ? ok(1) : ok(0);
    };
    const result = await runMutationGate(ws, deletedDiff, evidence());
    expect(result.status).toBe("witnessed");
    // The witness really saw the recreated pre-fix file…
    expect(seen).toEqual([ORIGINAL_LEGACY]);
    // …and the restore removed it again (the fix deletes it).
    expect(ws.execLog).toContain("rm -- 'src/legacy.ts'");
    expect(ws.files.has("src/legacy.ts")).toBe(false);
  });

  it("reverts files the fix CREATED by removing them, then restores them", async () => {
    const createdDiff = [
      "diff --git a/src/helper.ts b/src/helper.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/helper.ts",
      "@@ -0,0 +1 @@",
      "+export const h = 1;",
      "diff --git a/src/helper.test.ts b/src/helper.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/helper.test.ts",
      "@@ -0,0 +1 @@",
      "+import { h } from './helper';",
    ].join("\n");
    const ws = new FakeWorkspace({
      "src/helper.ts": "export const h = 1;\n",
      "src/helper.test.ts": "import { h } from './helper';\n",
    });
    ws.onExec = (cmd) =>
      cmd === WITNESS && !ws.files.has("src/helper.ts") ? ok(1) : ok(0);
    const result = await runMutationGate(ws, createdDiff, evidence());
    expect(result.status).toBe("witnessed");
    expect(ws.execLog).toContain("rm -- 'src/helper.ts'");
    // Restored after the gate.
    expect(ws.files.get("src/helper.ts")).toBe("export const h = 1;\n");
  });
});

// ── Skip paths (fail-open) ─────────────────────────────────────────────────────

describe("runMutationGate — skip paths", () => {
  it("skips when no source files changed", async () => {
    const testOnly = [
      "diff --git a/src/calc.test.ts b/src/calc.test.ts",
      "--- a/src/calc.test.ts",
      "+++ b/src/calc.test.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const result = await runMutationGate(workspace(), testOnly, evidence());
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("no source files");
  });

  it("skips when the turn made no witness claim", async () => {
    const sourceOnly = [
      "diff --git a/src/calc.ts b/src/calc.ts",
      "--- a/src/calc.ts",
      "+++ b/src/calc.ts",
      "@@ -1 +1 @@",
      "-export const answer = () => 41;",
      "+export const answer = () => 42;",
    ].join("\n");
    const result = await runMutationGate(
      workspace(),
      sourceOnly,
      evidence(false),
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("no witness claim");
  });

  it("skips when no passing test-like command was observed", async () => {
    const result = await runMutationGate(workspace(), DIFF, {
      lastOutcomes: new Map([[WITNESS, 1]]),
      flippedBy: null,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("no passing test-like command");
  });

  it("skips when a source segment cannot be faithfully reverted", async () => {
    const renameDiff = [
      "diff --git a/src/a.ts b/src/b.ts",
      "similarity index 100%",
      "rename from src/a.ts",
      "rename to src/b.ts",
      "\n" + DIFF.split("\n").slice(6).join("\n"), // keep the test-file segment
    ].join("\n");
    const result = await runMutationGate(workspace(), renameDiff, evidence());
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("cannot faithfully revert");
  });

  it("skips when the working tree diverged from the diff, touching nothing", async () => {
    const ws = workspace();
    ws.files.set("src/calc.ts", "diverged content\n");
    const result = await runMutationGate(ws, DIFF, evidence());
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("cannot reconstruct");
    expect(ws.files.get("src/calc.ts")).toBe("diverged content\n");
  });

  it("skips (and restores) when aborted mid-gate", async () => {
    const ws = workspace();
    const controller = new AbortController();
    controller.abort();
    const result = await runMutationGate(ws, DIFF, evidence(), {
      signal: controller.signal,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("aborted");
    expect(ws.files.get("src/calc.ts")).toBe(FIXED);
  });
});

// ── Restore is a hard guarantee ────────────────────────────────────────────────

describe("runMutationGate — restore", () => {
  it("skips and cleanly restores when a write fails during the REVERT itself", async () => {
    const multiDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-export const b = 1;",
      "+export const b = 2;",
      "diff --git a/src/ab.test.ts b/src/ab.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/ab.test.ts",
      "@@ -0,0 +1 @@",
      "+import './a'; import './b';",
    ].join("\n");
    const ws = new FakeWorkspace({
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/ab.test.ts": "import './a'; import './b';\n",
    });
    // src/a.ts reverts fine (tree now partially reverted); src/b.ts's revert
    // write throws once. The restore's own writes must still succeed.
    ws.failNextWriteFor.add("src/b.ts");
    const witness = vi.fn(() => ok(1));
    ws.onExec = witness;
    const result = await runMutationGate(ws, multiDiff, evidence());
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("shadow run failed");
    // The witness never ran against a half-reverted tree.
    expect(witness).not.toHaveBeenCalled();
    // The partially reverted tree was restored byte-for-byte.
    expect(ws.files.get("src/a.ts")).toBe("export const a = 2;\n");
    expect(ws.files.get("src/b.ts")).toBe("export const b = 2;\n");
  });

  it("throws LOUDLY when the working tree cannot be restored", async () => {
    const ws = workspace();
    ws.onExec = (cmd) => {
      if (cmd === WITNESS) {
        // Sabotage the restore only after the revert already happened.
        ws.failWritesFor.add("src/calc.ts");
        return ok(1);
      }
      return ok(0);
    };
    await expect(runMutationGate(ws, DIFF, evidence())).rejects.toThrow(
      /could not restore the working tree.*src\/calc\.ts/,
    );
  });
});

// ── Layer 2: mutation scoring ──────────────────────────────────────────────────

describe("runMutationGate — layer 2 (score)", () => {
  it("kills mutants the tests catch and reports survivors", async () => {
    const scoreDiff = [
      "diff --git a/src/flag.ts b/src/flag.ts",
      "--- a/src/flag.ts",
      "+++ b/src/flag.ts",
      "@@ -1,3 +1,5 @@",
      " export function f(a: number, b: number) {",
      "+  if (a === b) return true;",
      "+  if (a >= b) return true;",
      "   return false;",
      " }",
      "diff --git a/src/flag.test.ts b/src/flag.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/flag.test.ts",
      "@@ -0,0 +1 @@",
      "+import { f } from './flag';",
    ].join("\n");
    const fixed =
      "export function f(a: number, b: number) {\n  if (a === b) return true;\n  if (a >= b) return true;\n  return false;\n}\n";
    const original =
      "export function f(a: number, b: number) {\n  return false;\n}\n";
    const ws = new FakeWorkspace({
      "src/flag.ts": fixed,
      "src/flag.test.ts": "import { f } from './flag';\n",
    });
    ws.onExec = (cmd) => {
      if (cmd !== WITNESS) return ok(0);
      const content = ws.files.get("src/flag.ts")!;
      if (content === original) return ok(1); // layer 1: revert fails the test
      if (content.includes("!==")) return ok(1); // === mutant: killed
      if (content.includes("if (a > b)")) return ok(0); // >= mutant: survives
      return ok(0);
    };
    const result = await runMutationGate(ws, scoreDiff, evidence(), {
      score: true,
      maxMutants: 2,
    });
    expect(result.status).toBe("witnessed");
    expect(result.score).toMatchObject({
      mutantsTried: 2,
      mutantsKilled: 1,
      killRate: 0.5,
    });
    expect(result.score!.survivors).toEqual([
      { path: "src/flag.ts", line: 3, description: ">= → >" },
    ]);
    // The fix is intact after scoring.
    expect(ws.files.get("src/flag.ts")).toBe(fixed);
  });

  it("does not score vacuous turns", async () => {
    const ws = workspace();
    ws.onExec = () => ok(0);
    const result = await runMutationGate(ws, DIFF, evidence(), { score: true });
    expect(result.status).toBe("vacuous");
    expect(result.score).toBeUndefined();
  });
});
