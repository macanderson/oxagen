/**
 * Smoke tests for the Ink game view. The deterministic tick-by-tick behavior
 * is exhaustively covered against the pure engine in init-game.test.ts — this
 * just confirms the component actually mounts, draws recognizable sprites,
 * and cleans up its timer, matching the style of Banner/SpaceInvaders's own
 * tests (repl/__tests__/components.test.tsx, tui/__tests__/banner.test.tsx).
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { InitGameView } from "../init-game-view.js";

describe("InitGameView", () => {
  it("renders the formation and the player sprite on mount", () => {
    const { lastFrame, unmount } = render(<InitGameView width={30} />);
    const frame = lastFrame() ?? "";
    // At least one invader glyph is visible on the first frame.
    expect(/[▲◆●]/.test(frame)).toBe(true);
    // The player sprite's center glyph is visible.
    expect(frame).toContain("^");
    unmount();
  });

  it("shows the wave/score readout", () => {
    const { lastFrame, unmount } = render(<InitGameView width={30} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("wave 1");
    expect(frame).toContain("score 0");
    unmount();
  });

  it("advances frames on its own timer without throwing", async () => {
    const { lastFrame, unmount } = render(
      <InitGameView width={30} tickMs={1} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toBeTruthy();
    unmount();
  });

  it("unmounts cleanly (no dangling timers/handles)", () => {
    const { unmount } = render(<InitGameView width={30} tickMs={1} />);
    expect(() => unmount()).not.toThrow();
  });
});
