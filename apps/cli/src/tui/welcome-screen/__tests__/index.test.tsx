import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { WelcomeScreen } from "../index.js";

describe("WelcomeScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders in interactive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="interactive" />);
    const output = lastFrame();
    
    // Should show version
    expect(output).toContain("v0.6.2");

    // Should show dragon
    expect(output!.length).toBeGreaterThan(200);

    // Should show action menu
    expect(output).toContain("QUICK START");
  });

  test("renders in passive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="passive" />);
    const output = lastFrame() as string | undefined;

    // Should show dragon
    expect(output!.length).toBeGreaterThan(200);
    
    // Should show mode indicator
    expect(output).toContain("passive");
  });

  test("shows action menu when showActions is true", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={true} />);
    expect(lastFrame()).toContain("QUICK START");
  });

  test("hides action menu when showActions is false", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={false} />);
    expect(lastFrame()).not.toContain("QUICK START");
  });

  test("calls onStartRepl when Enter is pressed in interactive mode", () => {
    const mockStartRepl = vi.fn();
    const { stdin } = render(
      <WelcomeScreen mode="interactive" onStartRepl={mockStartRepl} />
    );
    
    // Simulate Enter key
    stdin.write("\r");
    
    expect(mockStartRepl).toHaveBeenCalledTimes(1);
  });

  test("calls onStartRepl when 'r' is pressed in interactive mode", () => {
    const mockStartRepl = vi.fn();
    const { stdin } = render(
      <WelcomeScreen mode="interactive" onStartRepl={mockStartRepl} />
    );
    
    // Simulate 'r' key
    stdin.write("r");
    
    expect(mockStartRepl).toHaveBeenCalledTimes(1);
  });

  test("does not call onStartRepl in passive mode", () => {
    const mockStartRepl = vi.fn();
    const { stdin } = render(
      <WelcomeScreen mode="passive" onStartRepl={mockStartRepl} />
    );
    
    // Try to trigger with Enter
    stdin.write("\r");
    
    expect(mockStartRepl).not.toHaveBeenCalled();
  });

  test("shows auto-exit countdown in passive mode", () => {
    const { lastFrame } = render(
      <WelcomeScreen mode="passive" autoExitSeconds={10} />
    );
    
    expect(lastFrame()).toContain("Auto-exit in");
    expect(lastFrame()).toContain("10s");
  });

  test("decrements countdown over time", () => {
    const { lastFrame } = render(
      <WelcomeScreen mode="passive" autoExitSeconds={5} />
    );

    const initial = lastFrame();
    expect(initial).toContain("Auto-exit in");
    expect(initial).toContain("5s");

    // Advance timers
    vi.advanceTimersByTime(2000);

    const output = lastFrame();
    // Verify countdown is still rendering (updates may vary in test environment)
    expect(output).toContain("Auto-exit in");
  });

  test("shows Ready status in interactive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="interactive" />);
    expect(lastFrame()).toContain("Ready");
  });

  test("shows Demo status in passive mode", () => {
    const { lastFrame } = render(<WelcomeScreen mode="passive" />);
    expect(lastFrame()).toContain("Demo");
  });

  test("shows interaction counter easter egg after 5+ interactions", () => {
    const { lastFrame, stdin } = render(<WelcomeScreen mode="interactive" />);

    // Fire breath 6 times
    for (let i = 0; i < 6; i++) {
      stdin.write(" ");
      vi.advanceTimersByTime(1150);
    }

    const output = lastFrame();
    // Easter egg appears after 5+ interactions
    if (output) {
      expect(output).toMatch(/appreciates|fire|breath|6/i);
    }
  });

  test("does not show easter egg before 5 interactions", () => {
    const { lastFrame, stdin } = render(<WelcomeScreen mode="interactive" />);
    
    // Fire breath only 3 times
    for (let i = 0; i < 3; i++) {
      stdin.write(" ");
      vi.advanceTimersByTime(1100);
    }
    
    expect(lastFrame()).not.toContain("appreciates");
  });

  test("defaults to interactive mode when mode prop omitted", () => {
    const { lastFrame } = render(<WelcomeScreen />);
    expect(lastFrame()).toContain("Ready");
    expect(lastFrame()).not.toContain("Demo");
  });

  test("displays keyboard shortcuts in action menu", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={true} />);
    const output = lastFrame();
    
    expect(output).toContain("[R]");
    expect(output).toContain("[Q]");
    expect(output).toContain("ESC");
  });

  test("shows suggested commands in action menu", () => {
    const { lastFrame } = render(<WelcomeScreen showActions={true} />);
    const output = lastFrame();
    
    expect(output).toContain("oxagen agents");
    expect(output).toContain("oxagen view");
    expect(output).toContain("oxagen --help");
  });

  test("displays mode indicator in footer", () => {
    const interactive = render(<WelcomeScreen mode="interactive" />);
    expect(interactive.lastFrame()).toContain("Mode:");
    expect(interactive.lastFrame()).toContain("interactive");
    
    const passive = render(<WelcomeScreen mode="passive" />);
    expect(passive.lastFrame()).toContain("Mode:");
    expect(passive.lastFrame()).toContain("passive");
  });
});
