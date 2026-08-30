import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  FilesPanel,
  resolveCtrlO,
  CTRL_O_OPEN_WINDOW_MS,
} from "../files-panel.js";
import type { TouchedFile, PackageLabel } from "../files-touched.js";
import type { ChangedFile, listChangedFiles } from "../git-diff.js";

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const ENTER = "\r";
const CTRL_O = "\x0f";

/**
 * The ops badge and package label colorize characters INDIVIDUALLY, so escape
 * codes sit between "[", "C", "," … — strip them before content assertions.
 */

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

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

const ENTRIES: TouchedFile[] = [
  { path: "apps/app/src/components/thing.tsx", ops: ["C", "U"], firstSeq: 1 },
  { path: "apps/cli/src/repl/other.ts", ops: ["R"], firstSeq: 2 },
];

const CHANGED: ChangedFile[] = [
  {
    path: "apps/app/src/components/thing.tsx",
    status: "M",
    untracked: false,
    insertions: 100,
    deletions: 44,
  },
];

const fakeList: typeof listChangedFiles = async () => CHANGED;
const fakeIo = { fileExists: () => true };
const fakePackage = (rel: string): PackageLabel =>
  rel.startsWith("apps/app/src/")
    ? { pkg: "@oxagen/app", display: rel.slice("apps/app/src/".length) }
    : { pkg: "@oxagen/cli", display: rel.slice("apps/cli/src/".length) };

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof FilesPanel>> = {},
) {
  const props: React.ComponentProps<typeof FilesPanel> = {
    cwd: "/repo",
    entries: ENTRIES,
    onClose: () => {},
    onShowDiff: () => {},
    onOpenFile: () => {},
    listFiles: fakeList,
    io: fakeIo,
    resolvePackage: fakePackage,
    ...overrides,
  };
  return render(<FilesPanel {...props} />);
}

describe("resolveCtrlO", () => {
  it("arms on the first press and opens within the window", () => {
    expect(resolveCtrlO(null, 1000)).toBe("arm");
    expect(resolveCtrlO(1000, 1000 + CTRL_O_OPEN_WINDOW_MS)).toBe("open");
    expect(resolveCtrlO(1000, 1001 + CTRL_O_OPEN_WINDOW_MS)).toBe("arm");
  });
});

describe("FilesPanel", () => {
  it("renders ops, package label, path after src/, and +/- counts", async () => {
    const { lastFrame } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("components/thing.tsx"));
    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("Files Touched");
    expect(frame).toContain("2 files this session");
    expect(frame).toContain("[C,U]");
    expect(frame).toContain("@oxagen/app: components/thing.tsx");
    expect(frame).toContain("+100");
    expect(frame).toContain("-44");
    // The read-only file shows its ops but no counts.
    expect(frame).toContain("[R]");
    expect(frame).toContain("@oxagen/cli: repl/other.ts");
    expect(frame).toContain("—");
  });

  it("shows the empty state before anything is touched", async () => {
    const { lastFrame } = renderPanel({ entries: [] });
    await until(() => (lastFrame() ?? "").includes("No files touched yet"));
  });

  it("moves the selection with the arrow keys, wrapping", async () => {
    const { lastFrame, stdin } = renderPanel();
    await until(() => (lastFrame() ?? "").includes("❯ "));
    expect(lastFrame()).toMatch(/❯.*thing\.tsx/);
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*other\.ts/.test(lastFrame() ?? ""));
    stdin.write(ARROW_DOWN); // wraps back to the first row
    await until(() => /❯.*thing\.tsx/.test(lastFrame() ?? ""));
    stdin.write(ARROW_UP); // wraps to the last row
    await until(() => /❯.*other\.ts/.test(lastFrame() ?? ""));
  });

  it("Enter opens the selected file's diff via onShowDiff", async () => {
    const onShowDiff = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onShowDiff });
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ENTER);
    await until(() => onShowDiff.mock.calls.length > 0);
    expect(onShowDiff).toHaveBeenCalledWith(
      "apps/app/src/components/thing.tsx",
    );
  });

  it("Enter on an unchanged (read-only) file explains instead of diffing", async () => {
    const onShowDiff = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onShowDiff });
    await until(() => (lastFrame() ?? "").includes("❯ "));
    stdin.write(ARROW_DOWN);
    await until(() => /❯.*other\.ts/.test(lastFrame() ?? ""));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("nothing to diff"));
    expect(onShowDiff).not.toHaveBeenCalled();
  });

  it("double Ctrl-O opens the highlighted file in the editor; a single press only arms", async () => {
    const onOpenFile = vi.fn();
    let t = 10_000;
    const { lastFrame, stdin } = renderPanel({ onOpenFile, now: () => t });
    await until(() => (lastFrame() ?? "").includes("❯ "));

    stdin.write(CTRL_O);
    await until(() => (lastFrame() ?? "").includes("ctrl+o again"));
    expect(onOpenFile).not.toHaveBeenCalled();

    t += 500; // within the window
    stdin.write(CTRL_O);
    await until(() => onOpenFile.mock.calls.length > 0);
    expect(onOpenFile).toHaveBeenCalledWith(
      "apps/app/src/components/thing.tsx",
    );
  });

  it("an expired window re-arms instead of opening", async () => {
    const onOpenFile = vi.fn();
    let t = 10_000;
    const { lastFrame, stdin } = renderPanel({ onOpenFile, now: () => t });
    await until(() => (lastFrame() ?? "").includes("❯ "));

    stdin.write(CTRL_O);
    await until(() => (lastFrame() ?? "").includes("ctrl+o again"));
    t += CTRL_O_OPEN_WINDOW_MS + 1; // too late
    stdin.write(CTRL_O);
    // Still armed (hint visible), but never opened.
    await until(() => (lastFrame() ?? "").includes("ctrl+o again"));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("any other key breaks the double-press chain", async () => {
    const onOpenFile = vi.fn();
    let t = 10_000;
    const { lastFrame, stdin } = renderPanel({ onOpenFile, now: () => t });
    await until(() => (lastFrame() ?? "").includes("❯ "));

    stdin.write(CTRL_O);
    await until(() => (lastFrame() ?? "").includes("ctrl+o again"));
    stdin.write(ARROW_DOWN); // disarms
    await until(() => !(lastFrame() ?? "").includes("ctrl+o again"));
    t += 100;
    stdin.write(CTRL_O); // arms again rather than opening
    await until(() => (lastFrame() ?? "").includes("ctrl+o again"));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("Esc closes the panel", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderPanel({ onClose });
    await until(() => (lastFrame() ?? "").includes("Files Touched"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });
});
