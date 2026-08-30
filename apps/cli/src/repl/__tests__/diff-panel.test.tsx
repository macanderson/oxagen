import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { DiffPanel } from "../diff-panel.js";
import type {
  ChangedFile,
  listChangedFiles,
  getFileDiff,
} from "../git-diff.js";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ENTER = "\r";

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously (never fixed sleeps). */
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

const FILES: ChangedFile[] = [
  {
    path: "src/alpha.ts",
    status: "M",
    untracked: false,
    insertions: 3,
    deletions: 1,
  },
  {
    path: "src/bravo.ts",
    status: "A",
    untracked: false,
    insertions: 5,
    deletions: 0,
  },
];

const DIFF_BY_PATH: Record<string, string> = {
  "src/alpha.ts": [
    "diff --git a/src/alpha.ts b/src/alpha.ts",
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1,2 +1,2 @@",
    "-old alpha",
    "+new ALPHA_MARK",
    " tail",
  ].join("\n"),
  "src/bravo.ts": [
    "diff --git a/src/bravo.ts b/src/bravo.ts",
    "--- /dev/null",
    "+++ b/src/bravo.ts",
    "@@ -0,0 +1 @@",
    "+BRAVO_MARK",
  ].join("\n"),
};

const fakeList: typeof listChangedFiles = async () => FILES;
const fakeLoad: typeof getFileDiff = async (_root, file) =>
  DIFF_BY_PATH[file.path] ?? "";

describe("DiffPanel — list mode", () => {
  it("renders each changed file with its status char and +/- counts", async () => {
    const { lastFrame } = render(
      <DiffPanel
        cwd="/repo"
        onClose={() => {}}
        listFiles={fakeList}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("src/alpha.ts"));
    const frame = lastFrame()!;
    expect(frame).toContain("± changes");
    expect(frame).toContain("src/alpha.ts");
    expect(frame).toContain("src/bravo.ts");
    expect(frame).toContain("+3");
    expect(frame).toContain("-1");
  });

  it("shows the empty state when the working tree is clean", async () => {
    const { lastFrame } = render(
      <DiffPanel
        cwd="/repo"
        onClose={() => {}}
        listFiles={async () => []}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("Working tree clean"));
    expect(lastFrame()).toContain("no changes vs HEAD");
  });

  it("moves the selection with the arrow keys", async () => {
    const { lastFrame, stdin } = render(
      <DiffPanel
        cwd="/repo"
        onClose={() => {}}
        listFiles={fakeList}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("❯ "));
    expect(lastFrame()).toMatch(/❯.*src\/alpha\.ts/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*src\/bravo\.ts/.test(lastFrame() ?? ""));
  });

  it("Esc from the list closes the panel", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = render(
      <DiffPanel
        cwd="/repo"
        onClose={onClose}
        listFiles={fakeList}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("src/alpha.ts"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length === 1);
  });
});

describe("DiffPanel — diff mode", () => {
  it("Enter opens the diff with a line-number gutter and the file's content", async () => {
    const { lastFrame, stdin } = render(
      <DiffPanel
        cwd="/repo"
        onClose={() => {}}
        listFiles={fakeList}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("ALPHA_MARK"));
    const frame = lastFrame()!;
    expect(frame).toContain("│"); // gutter divider (line numbers on)
    expect(frame).toContain("1/2"); // header shows position among files
    expect(frame).toContain("↑↓ scroll"); // diff-mode footer (scroll hints)
  });

  it("[ and ] cycle to the next/previous file's diff (wrapping)", async () => {
    const { lastFrame, stdin } = render(
      <DiffPanel
        cwd="/repo"
        onClose={() => {}}
        listFiles={fakeList}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("ALPHA_MARK"));
    stdin.write("]"); // next file → bravo
    await until(() => (lastFrame() ?? "").includes("BRAVO_MARK"));
    expect(lastFrame()).toContain("2/2");
    stdin.write("["); // prev file → back to alpha
    await until(() => (lastFrame() ?? "").includes("ALPHA_MARK"));
    expect(lastFrame()).toContain("1/2");
  });

  it("Esc returns from the diff to the list without closing", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = render(
      <DiffPanel
        cwd="/repo"
        onClose={onClose}
        listFiles={fakeList}
        loadDiff={fakeLoad}
      />,
    );
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("ALPHA_MARK"));
    stdin.write(ESC); // back to list, not close
    await until(() => (lastFrame() ?? "").includes("↑↓ navigate"));
    expect(onClose).not.toHaveBeenCalled();
    stdin.write(ESC); // now close
    await until(() => onClose.mock.calls.length === 1);
  });
});

describe("DiffPanel — scrolling", () => {
  const LONG_FILES: ChangedFile[] = [
    { path: "src/long.ts", status: "M", untracked: false },
  ];
  const LONG_DIFF = [
    "diff --git a/src/long.ts b/src/long.ts",
    "--- a/src/long.ts",
    "+++ b/src/long.ts",
    "@@ -1,8 +1,8 @@",
    "+alpha",
    "+bravo",
    "+charlie",
    "+delta",
    "+echo",
    "+foxtrot",
    "+golf",
    "+hotel",
  ].join("\n");
  const longList: typeof listChangedFiles = async () => LONG_FILES;
  const longLoad: typeof getFileDiff = async () => LONG_DIFF;

  it("slices to maxBodyRows and G/g jump the visible window to bottom/top", async () => {
    const { lastFrame, stdin } = render(
      <DiffPanel
        cwd="/repo"
        onClose={() => {}}
        listFiles={longList}
        loadDiff={longLoad}
        initialPath="src/long.ts"
        maxBodyRows={6}
      />,
    );
    // initialPath opens straight into the diff; top of the window shows early
    // lines but not the last one.
    await until(() => (lastFrame() ?? "").includes("alpha"));
    expect(lastFrame()).not.toContain("hotel");
    stdin.write("G"); // jump to bottom
    await until(() => (lastFrame() ?? "").includes("hotel"));
    expect(lastFrame()).not.toContain("alpha");
    stdin.write("g"); // back to top
    await until(() => (lastFrame() ?? "").includes("alpha"));
    expect(lastFrame()).not.toContain("hotel");
  });
});
