import { describe, test, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { WelcomeScreen } from "../index.js";

/**
 * Ink delivers stdin to useInput and flushes renders on a microtask/timer, so
 * post-mount state changes are not reflected in `lastFrame()` synchronously.
 * Use real timers + a short settle tick (never fake timers, which freeze ink's
 * render flush) to let the next frame land before asserting.
 */
const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor: condition timed out");
    }
    await tick(10);
  }
}

describe("WelcomeScreen", () => {
  test("renders in interactive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="interactive" />);
    const output = lastFrame() ?? "";

    // Should show version
    expect(output).toContain("v0.6.2");

    // Should show dragon
    expect(output.length).toBeGreaterThan(200);

    // Should show action menu
    expect(output).toContain("QUICK START");
  });

  test("renders in passive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="passive" />);
    const output = lastFrame() ?? "";

    // Should show dragon
    expect(output.length).toBeGreaterThan(200);

    // Should show mode indicator
    expect(output).toContain("passive");
  });

  test("shows action menu when showActions is true", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={true} />);
    expect(lastFrame() ?? "").toContain("QUICK START");
  });

  test("hides action menu when showActions is false", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={false} />);
    expect(lastFrame() ?? "").not.toContain("QUICK START");
  });

  test("calls onStartRepl when Enter is pressed in interactive mode", async () => {
    const mockStartRepl = vi.fn();
    const { stdin } = render(
      <WelcomeScreen mode="interactive" onStartRepl={mockStartRepl} />
    );

    // Simulate Enter key
    stdin.write("\r");
    await tick();

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
  });

  test("calls onStartRepl when 'r' is pressed in interactive mode", async () => {
    const mockStartRepl = vi.fn();
    const { stdin } = render(
      <WelcomeScreen mode="interactive" onStartRepl={mockStartRepl} />
    );

    // Simulate 'r' key
    stdin.write("r");
    await tick();

    expect(mockStartRepl).toHaveBeenCalledTimes(1);
  });

  test("does not call onStartRepl in passive mode", async () => {
    const mockStartRepl = vi.fn();
    const { stdin } = render(
      <WelcomeScreen mode="passive" onStartRepl={mockStartRepl} />
    );

    // Try to trigger with Enter
    stdin.write("\r");
    await tick();

    expect(mockStartRepl).not.toHaveBeenCalled();
  });

  test("shows auto-exit countdown in passive mode", () => {
    const { lastFrame, unmount } = render(
      <WelcomeScreen mode="passive" autoExitSeconds={10} />
    );

    expect(lastFrame() ?? "").toContain("Auto-exit in");
    expect(lastFrame() ?? "").toContain("10s");
    unmount();
  });

  test("decrements countdown over time", async () => {
    const { lastFrame, unmount } = render(
      <WelcomeScreen mode="passive" autoExitSeconds={5} />
    );

    expect(lastFrame() ?? "").toContain("5s");

    // After the 1000ms interval fires, the countdown should decrement.
    await waitFor(() => /[34]s/.test(lastFrame() ?? ""));
    expect(lastFrame() ?? "").toMatch(/[34]s/);
    unmount();
  });

  test("shows Ready status in interactive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="interactive" />);
    expect(lastFrame() ?? "").toContain("Ready");
  });

  test("shows Demo status in passive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="passive" />);
    expect(lastFrame() ?? "").toContain("Demo");
  });

  test("shows interaction counter easter egg after 5+ interactions", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WelcomeScreen mode="interactive" />
    );

    // Fire breath 6 times (each space press increments the interaction count)
    for (let i = 0; i < 6; i++) {
      stdin.write(" ");
      await tick(15); // Let each input register as a discrete event
    }

    // Easter egg appears after 5+ interactions
    await waitFor(() => /appreciates|fire breaths/.test(lastFrame() ?? ""));
    expect(lastFrame() ?? "").toMatch(/appreciates|fire breaths/);
    unmount();
  });

  test("does not show easter egg before 5 interactions", async () => {
    const { lastFrame, stdin, unmount } = render(
      <WelcomeScreen mode="interactive" />
    );

    // Fire breath only 3 times
    for (let i = 0; i < 3; i++) {
      stdin.write(" ");
      await tick(15);
    }

    expect(lastFrame() ?? "").not.toContain("appreciates");
    unmount();
  });

  test("defaults to interactive mode when mode prop omitted", () => {
    const { lastFrame } = render(<WelcomeScreen />);
    expect(lastFrame() ?? "").toContain("Ready");
    expect(lastFrame() ?? "").not.toContain("Demo");
  });

  test("displays keyboard shortcuts in action menu", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={true} />);
    const output = lastFrame() ?? "";

    expect(output).toContain("[R]");
    expect(output).toContain("[Q]");
    expect(output).toContain("ESC");
  });

  test("shows suggested commands in action menu", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={true} />);
    const output = lastFrame() ?? "";

    expect(output).toContain("oxagen agents");
    expect(output).toContain("oxagen view");
    expect(output).toContain("oxagen --help");
  });

  test("displays mode indicator in footer", () => {
    const interactive = render(<WelcomeScreen mode="interactive" />);
    expect(interactive.lastFrame() ?? "").toContain("Mode:");
    expect(interactive.lastFrame() ?? "").toContain("interactive");

    const passive = render(<WelcomeScreen mode="passive" />);
    expect(passive.lastFrame() ?? "").toContain("Mode:");
    expect(passive.lastFrame() ?? "").toContain("passive");
  });
});
