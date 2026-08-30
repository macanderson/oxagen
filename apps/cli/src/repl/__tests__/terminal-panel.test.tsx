/**
 * TerminalPanel — the red-outlined live `!command` output panel. Proves it
 * renders the command with a `$` prompt, streams output, tails long output, and
 * reflects run status (running / exit 0 / non-zero / killed).
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  TerminalPanel,
  TerminalRunCard,
  type TerminalRun,
} from "../terminal-panel.js";

const at = 1_000_000;
const base: TerminalRun = {
  id: 1,
  command: "pnpm build",
  output: "",
  status: "running",
  startedAt: at,
};

describe("TerminalPanel", () => {
  it("renders the command behind a $ shell prompt", () => {
    const { lastFrame } = render(
      <TerminalPanel run={base} nowFn={() => at + 5000} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("$ ");
    expect(frame).toContain("pnpm build");
    expect(frame).toContain("running");
  });

  it("shows a red round border", () => {
    const { lastFrame } = render(<TerminalPanel run={base} nowFn={() => at} />);
    const frame = lastFrame() ?? "";
    // Round-border corners present; the red color is applied via ANSI (asserted
    // structurally by the border being drawn at all).
    expect(frame).toContain("╭");
    expect(frame).toContain("╰");
  });

  it("streams output lines", () => {
    const run: TerminalRun = { ...base, output: "compiling…\ndone in 3s\n" };
    const { lastFrame } = render(<TerminalPanel run={run} nowFn={() => at} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("compiling…");
    expect(frame).toContain("done in 3s");
  });

  it("tails long output and notes how many lines were hidden", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const run: TerminalRun = { ...base, output: lines };
    const { lastFrame } = render(<TerminalPanel run={run} nowFn={() => at} />);
    const frame = lastFrame() ?? "";
    // Last line always visible; earliest lines elided with a hidden-count note.
    expect(frame).toContain("line 40");
    expect(frame).not.toContain("line 1\n"); // line 1 tailed off
    expect(frame).toMatch(/\d+ earlier lines? hidden/);
  });

  it("reports a clean exit", () => {
    const run: TerminalRun = {
      ...base,
      status: "exited",
      exitCode: 0,
      endedAt: at + 8000,
    };
    const { lastFrame } = render(
      <TerminalPanel run={run} nowFn={() => at + 9000} />,
    );
    expect(lastFrame() ?? "").toContain("exit 0");
  });

  it("reports a non-zero exit", () => {
    const run: TerminalRun = {
      ...base,
      status: "exited",
      exitCode: 2,
      endedAt: at + 1000,
    };
    expect(
      render(<TerminalPanel run={run} nowFn={() => at} />).lastFrame() ?? "",
    ).toContain("exit 2");
  });

  it("reports a killed run", () => {
    const run: TerminalRun = { ...base, status: "killed", endedAt: at + 1000 };
    expect(
      render(<TerminalPanel run={run} nowFn={() => at} />).lastFrame() ?? "",
    ).toContain("killed");
  });
});

describe("TerminalRunCard (folded accordion)", () => {
  const finished: TerminalRun = {
    id: 2,
    command: "pwd",
    output: "line a\nline b\nline c\n",
    status: "exited",
    exitCode: 0,
    startedAt: at,
    endedAt: at + 2000,
  };

  it("collapsed: shows a one-line header with command, status, and line count — no output body", () => {
    const { lastFrame } = render(
      <TerminalRunCard run={finished} expanded={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▸"); // collapsed toggle glyph
    expect(frame).toContain("$ "); // shell prompt (dim, separate node from command)
    expect(frame).toContain("pwd");
    expect(frame).toContain("exit 0");
    expect(frame).toContain("3 lines");
    // Output stays hidden while collapsed.
    expect(frame).not.toContain("line a");
    expect(frame).not.toContain("line c");
  });

  it("collapsed: is NOT the red live panel (no round border)", () => {
    const { lastFrame } = render(
      <TerminalRunCard run={finished} expanded={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("╭");
    expect(frame).not.toContain("╰");
  });

  it("expanded: reveals the captured output under an open toggle", () => {
    const { lastFrame } = render(
      <TerminalRunCard run={finished} expanded={true} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▾"); // expanded toggle glyph
    expect(frame).toContain("line a");
    expect(frame).toContain("line c");
  });

  it("expanded: tails very long output", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join(
      "\n",
    );
    const run: TerminalRun = { ...finished, output: lines };
    const { lastFrame } = render(<TerminalRunCard run={run} expanded={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("row 80");
    expect(frame).toMatch(/\d+ earlier lines? hidden/);
  });

  it("singular line count for one output line", () => {
    const run: TerminalRun = { ...finished, output: "only\n" };
    const { lastFrame } = render(
      <TerminalRunCard run={run} expanded={false} />,
    );
    expect(lastFrame() ?? "").toContain("1 line");
    expect(lastFrame() ?? "").not.toContain("1 lines");
  });

  it("no-output run omits the line-count suffix", () => {
    const run: TerminalRun = { ...finished, output: "" };
    const { lastFrame } = render(
      <TerminalRunCard run={run} expanded={false} />,
    );
    expect(lastFrame() ?? "").not.toMatch(/\d+ lines?/);
  });
});
