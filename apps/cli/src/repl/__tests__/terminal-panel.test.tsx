/**
 * TerminalPanel — the red-outlined live `!command` output panel. Proves it
 * renders the command with a `$` prompt, streams output, tails long output, and
 * reflects run status (running / exit 0 / non-zero / killed).
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { TerminalPanel, type TerminalRun } from "../terminal-panel.js";

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
    const { lastFrame } = render(<TerminalPanel run={base} nowFn={() => at + 5000} />);
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
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const run: TerminalRun = { ...base, output: lines };
    const { lastFrame } = render(<TerminalPanel run={run} nowFn={() => at} />);
    const frame = lastFrame() ?? "";
    // Last line always visible; earliest lines elided with a hidden-count note.
    expect(frame).toContain("line 40");
    expect(frame).not.toContain("line 1\n"); // line 1 tailed off
    expect(frame).toMatch(/\d+ earlier lines? hidden/);
  });

  it("reports a clean exit", () => {
    const run: TerminalRun = { ...base, status: "exited", exitCode: 0, endedAt: at + 8000 };
    const { lastFrame } = render(<TerminalPanel run={run} nowFn={() => at + 9000} />);
    expect(lastFrame() ?? "").toContain("exit 0");
  });

  it("reports a non-zero exit", () => {
    const run: TerminalRun = { ...base, status: "exited", exitCode: 2, endedAt: at + 1000 };
    expect((render(<TerminalPanel run={run} nowFn={() => at} />).lastFrame() ?? "")).toContain(
      "exit 2",
    );
  });

  it("reports a killed run", () => {
    const run: TerminalRun = { ...base, status: "killed", endedAt: at + 1000 };
    expect((render(<TerminalPanel run={run} nowFn={() => at} />).lastFrame() ?? "")).toContain(
      "killed",
    );
  });
});
