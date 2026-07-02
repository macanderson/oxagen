/**
 * Unit tests for the full-screen terminal-geometry hook.
 *
 * Locks two contracts the REPL relies on: (1) the hook reports the current stdout
 * dimensions and marks `fullscreen: false` when stdout is not a TTY (the case
 * under ink-testing-library, so the component renders inline), and (2) the
 * alternate-screen control sequences are the exact, distinct DEC private-mode
 * strings launchRepl writes to enter/leave the alt buffer.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import {
  useTerminalSize,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  CURSOR_HOME,
} from "../use-terminal-size.js";

function Probe(): React.ReactElement {
  const { rows, cols, fullscreen } = useTerminalSize();
  return <Text>{`${cols}x${rows}:${fullscreen}`}</Text>;
}

describe("useTerminalSize", () => {
  it("reports stdout geometry and fullscreen=false off a TTY", () => {
    const { lastFrame } = render(<Probe />);
    // ink-testing-library's fake stdout is not a TTY, so fullscreen must be false
    // and both dimensions must resolve to positive integers (real or fallback).
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/^\d+x\d+:false$/);
    const [cols, rest] = frame.split("x");
    const rows = rest!.split(":")[0]!;
    expect(Number(cols)).toBeGreaterThan(0);
    expect(Number(rows)).toBeGreaterThan(0);
  });

  it("exposes the exact, distinct alt-screen control sequences", () => {
    expect(ENTER_ALT_SCREEN).toBe("[?1049h");
    expect(LEAVE_ALT_SCREEN).toBe("[?1049l");
    expect(CURSOR_HOME).toBe("[H");
    expect(ENTER_ALT_SCREEN).not.toBe(LEAVE_ALT_SCREEN);
  });
});
