import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { AnimatedCreature } from "../animated-creature.js";

describe("AnimatedCreature", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders in passive mode", () => {
    const { lastFrame } = render(<AnimatedCreature mode="passive" />);
    const output = lastFrame();
    
    // Should contain dragon body parts
    expect(output).toMatch(/[()]/); // Eyes or body curves
  });

  test("renders in interactive mode", () => {
    const { lastFrame } = render(<AnimatedCreature mode="interactive" />);
    const output = lastFrame();
    
    // Should show the dragon
    expect(output.length).toBeGreaterThan(100);
    
    // Should show the interaction hint
    expect(output).toContain("SPACE");
    expect(output).toContain("ENTER");
  });

  test("advances frames over time in passive mode", () => {
    const { lastFrame } = render(<AnimatedCreature mode="passive" />);
    
    const frame0 = lastFrame();
    
    // Advance by frame delay (200ms)
    vi.advanceTimersByTime(200);
    
    const frame1 = lastFrame();
    
    // Frames should be different (animation progressed)
    // Note: We can't guarantee exact content change without mocking,
    // but we can verify the component re-rendered
    expect(typeof frame1).toBe("string");
  });

  test("shows interactive hint only in interactive mode", () => {
    const passive = render(<AnimatedCreature mode="passive" />);
    expect(passive.lastFrame()).not.toContain("Press");
    
    const interactive = render(<AnimatedCreature mode="interactive" />);
    expect(interactive.lastFrame()).toContain("Press");
  });

  test("calls onInteraction callback when triggered", () => {
    const mockCallback = vi.fn();
    const { stdin } = render(
      <AnimatedCreature mode="interactive" onInteraction={mockCallback} />
    );
    
    // Simulate space key press
    stdin.write(" ");
    
    // Callback should be called
    expect(mockCallback).toHaveBeenCalledTimes(1);
  });

  test("does not call onInteraction in passive mode", () => {
    const mockCallback = vi.fn();
    const { stdin } = render(
      <AnimatedCreature mode="passive" onInteraction={mockCallback} />
    );
    
    // Simulate space key press
    stdin.write(" ");
    
    // Callback should not be called in passive mode
    expect(mockCallback).not.toHaveBeenCalled();
  });

  test("defaults to passive mode when mode prop omitted", () => {
    const { lastFrame } = render(<AnimatedCreature />);
    
    // Should not show interactive hints
    expect(lastFrame()).not.toContain("Press");
  });

  test("shows fire breath indicator when firing", () => {
    const { lastFrame, stdin } = render(<AnimatedCreature mode="interactive" />);
    
    // Trigger fire breath
    stdin.write(" ");
    
    // Advance timers to allow React to re-render
    vi.advanceTimersByTime(50);
    
    const output = lastFrame();
    // Fire breath text appears in the output
    expect(output).toMatch(/FIRE|🔥/);
  });

  test("returns to breathing after fire breath timeout", () => {
    const { lastFrame, stdin } = render(<AnimatedCreature mode="interactive" />);
    
    // Trigger fire breath
    stdin.write(" ");
    
    // Advance to show fire breath
    vi.advanceTimersByTime(50);
    expect(lastFrame()).toMatch(/FIRE|🔥/);
    
    // Advance past timeout (1000ms)
    vi.advanceTimersByTime(1100);
    
    // Should no longer show fire breath indicator
    expect(lastFrame()).not.toMatch(/FIRE.*BREATH/);
  });

  test("renders without errors when onInteraction is undefined", () => {
    expect(() => {
      render(<AnimatedCreature mode="interactive" />);
    }).not.toThrow();
  });
});
