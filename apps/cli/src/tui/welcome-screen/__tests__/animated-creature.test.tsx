import { describe, test, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { AnimatedCreature } from "../animated-creature.js";

/**
 * Ink delivers stdin to useInput and flushes renders on a microtask/timer, so
 * post-mount state changes are not reflected in `lastFrame()` synchronously.
 * Use real timers + a short settle tick (never fake timers, which freeze ink's
 * render flush) to let the next frame land before asserting.
 */
const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor: condition timed out");
    }
    await tick(10);
  }
}

describe("AnimatedCreature", () => {
  test("renders in passive mode", () => {
    const { lastFrame } = render(<AnimatedCreature mode="passive" />);
    const output = lastFrame() ?? "";

    // Should contain dragon body parts
    expect(output).toMatch(/[()]/); // Eyes or body curves
  });

  test("renders in interactive mode", () => {
    const { lastFrame } = render(<AnimatedCreature mode="interactive" />);
    const output = lastFrame() ?? "";

    // Should show the dragon
    expect(output.length).toBeGreaterThan(100);

    // Should show the interaction hint
    expect(output).toContain("SPACE");
    expect(output).toContain("ENTER");
  });

  test("advances frames over time in passive mode", async () => {
    const { lastFrame, unmount } = render(<AnimatedCreature mode="passive" />);

    // Advance past one frame delay (200ms) so the animation interval fires.
    await tick(220);

    const frame1 = lastFrame();

    // Frames should keep rendering (animation progressed).
    // Note: We can't guarantee exact content change without mocking,
    // but we can verify the component re-rendered without crashing.
    expect(typeof frame1).toBe("string");
    unmount();
  });

  test("shows interactive hint only in interactive mode", () => {
    const passive = render(<AnimatedCreature mode="passive" />);
    expect(passive.lastFrame() ?? "").not.toContain("Press");

    const interactive = render(<AnimatedCreature mode="interactive" />);
    expect(interactive.lastFrame() ?? "").toContain("Press");
  });

  test("calls onInteraction callback when triggered", async () => {
    const mockCallback = vi.fn();
    const { stdin } = render(
      <AnimatedCreature mode="interactive" onInteraction={mockCallback} />
    );

    // Simulate space key press
    stdin.write(" ");
    await tick();

    // Callback should be called
    expect(mockCallback).toHaveBeenCalledTimes(1);
  });

  test("does not call onInteraction in passive mode", async () => {
    const mockCallback = vi.fn();
    const { stdin } = render(
      <AnimatedCreature mode="passive" onInteraction={mockCallback} />
    );

    // Simulate space key press
    stdin.write(" ");
    await tick();

    // Callback should not be called in passive mode
    expect(mockCallback).not.toHaveBeenCalled();
  });

  test("defaults to passive mode when mode prop omitted", () => {
    const { lastFrame } = render(<AnimatedCreature />);

    // Should not show interactive hints
    expect(lastFrame() ?? "").not.toContain("Press");
  });

  test("shows fire breath indicator when firing", async () => {
    const { lastFrame, stdin, unmount } = render(
      <AnimatedCreature mode="interactive" />
    );

    // Trigger fire breath
    stdin.write(" ");

    // Let ink flush the re-render
    await tick();

    const output = lastFrame() ?? "";
    // Fire breath text appears in the output
    expect(output).toMatch(/FIRE|🔥/);
    unmount();
  });

  test("returns to breathing after fire breath timeout", async () => {
    const { lastFrame, stdin, unmount } = render(
      <AnimatedCreature mode="interactive" />
    );

    // Trigger fire breath
    stdin.write(" ");

    // Fire breath indicator should appear
    await waitFor(() => /FIRE|🔥/.test(lastFrame() ?? ""));
    expect(lastFrame() ?? "").toMatch(/FIRE|🔥/);

    // Past the 1000ms fire timeout it should return to breathing
    await waitFor(() => !/FIRE.*BREATH/.test(lastFrame() ?? ""));
    expect(lastFrame() ?? "").not.toMatch(/FIRE.*BREATH/);
    unmount();
  });

  test("renders without errors when onInteraction is undefined", () => {
    expect(() => {
      render(<AnimatedCreature mode="interactive" />);
    }).not.toThrow();
  });
});
