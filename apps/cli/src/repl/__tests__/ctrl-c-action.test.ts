import { describe, it, expect } from "vitest";
import {
  resolveCtrlC,
  CTRL_C_EXIT_WINDOW_MS,
  type CtrlCContext,
} from "../ctrl-c-action.js";

const NOW = 1_000_000;

function ctx(overrides: Partial<CtrlCContext> = {}): CtrlCContext {
  return {
    terminalRunning: false,
    streaming: false,
    inputEmpty: true,
    lastCtrlCMs: null,
    ...overrides,
  };
}

describe("resolveCtrlC", () => {
  it("kills a running !command child before anything else", () => {
    // Even while streaming with text and armed, the terminal child wins.
    expect(
      resolveCtrlC(
        ctx({
          terminalRunning: true,
          streaming: true,
          inputEmpty: false,
          lastCtrlCMs: NOW - 10,
        }),
        NOW,
      ),
    ).toBe("kill-terminal");
  });

  it("cancels a streaming turn when no terminal child is running", () => {
    expect(resolveCtrlC(ctx({ streaming: true, inputEmpty: false }), NOW)).toBe(
      "cancel-turn",
    );
  });

  it("clears the input (never exits) when idle with text in the buffer", () => {
    expect(resolveCtrlC(ctx({ inputEmpty: false }), NOW)).toBe("clear-input");
  });

  it("arms (does NOT exit) on the first idle Ctrl-C with an empty buffer", () => {
    expect(resolveCtrlC(ctx({ lastCtrlCMs: null }), NOW)).toBe("arm-exit");
  });

  it("exits on a second idle Ctrl-C within the window", () => {
    const first = NOW;
    const second = NOW + CTRL_C_EXIT_WINDOW_MS; // exactly on the boundary
    expect(resolveCtrlC(ctx({ lastCtrlCMs: first }), second)).toBe("exit");
  });

  it("re-arms rather than exits once the window has lapsed", () => {
    const first = NOW;
    const late = NOW + CTRL_C_EXIT_WINDOW_MS + 1;
    expect(resolveCtrlC(ctx({ lastCtrlCMs: first }), late)).toBe("arm-exit");
  });

  it("prioritizes clearing input over exit-arming even when previously armed", () => {
    // A single idle Ctrl-C armed exit; the user then typed. The next Ctrl-C must
    // clear the (now non-empty) input, not exit.
    expect(
      resolveCtrlC(ctx({ inputEmpty: false, lastCtrlCMs: NOW - 100 }), NOW),
    ).toBe("clear-input");
  });
});
