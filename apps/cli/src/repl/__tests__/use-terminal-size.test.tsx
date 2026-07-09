/**
 * Unit tests for the REPL's terminal-geometry hook.
 *
 * Locks the contract the REPL relies on: the hook reports the current stdout
 * dimensions and marks `fullscreen: false` when stdout is not a TTY (the case
 * under ink-testing-library, so the component renders inline and skips the
 * live-frame height cap).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useTerminalSize } from "../use-terminal-size.js";

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
});
