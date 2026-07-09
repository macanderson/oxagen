import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Banner, WORDMARK, bannerRowCount, sunsetColorAt } from "../banner.js";

describe("Banner", () => {
  it("renders the gradient OXAGEN wordmark and nothing else", () => {
    const { lastFrame } = render(<Banner />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("█");
    // Wordmark only — no info lines duplicating what the HeaderBar and the
    // REPO dock already show (version, scope, cwd).
    expect(frame.toLowerCase()).not.toContain("oxagen.sh");
    expect(frame).not.toContain("v0.");
    expect(frame).not.toContain("◯");
  });

  it("keeps a fixed row count while animating (no layout jump)", () => {
    const { lastFrame } = render(<Banner animate />);
    const frame = lastFrame() ?? "";
    // All wordmark rows are reserved from the first frame even before reveal.
    expect(frame.split("\n").length).toBeGreaterThanOrEqual(WORDMARK.length);
  });
});

describe("WORDMARK", () => {
  it("keeps the exact OXAGEN block mark init-reveal shares", () => {
    expect(WORDMARK).toEqual([
      " ██████  ██   ██  █████   ██████  ███████ ███    ██",
      "██    ██  ██ ██  ██   ██ ██       ██      ████   ██",
      "██    ██   ███   ███████ ██   ███ █████   ██ ██  ██",
      "██    ██  ██ ██  ██   ██ ██    ██ ██      ██  ██ ██",
      " ██████  ██   ██ ██   ██  ██████  ███████ ██   ████",
    ]);
  });
});

describe("sunsetColorAt", () => {
  it("starts at amber and ends at burnt red, clamping out-of-range input", () => {
    expect(sunsetColorAt(0)).toBe("#fbbf24");
    expect(sunsetColorAt(1)).toBe("#b91c1c");
    expect(sunsetColorAt(-5)).toBe("#fbbf24");
    expect(sunsetColorAt(5)).toBe("#b91c1c");
  });

  it("moves monotonically away from amber as t grows", () => {
    // The red channel is not monotone across all stops, but green decays
    // steadily from amber (0xbf) to burnt red (0x1c) — assert on that.
    const green = (hex: string): number => parseInt(hex.slice(3, 5), 16);
    let prev = green(sunsetColorAt(0));
    for (let t = 0.1; t <= 1; t += 0.1) {
      const g = green(sunsetColorAt(t));
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
  });
});

describe("bannerRowCount", () => {
  it("budgets wordmark rows + the bottom margin", () => {
    expect(bannerRowCount()).toBe(WORDMARK.length + 1);
  });
});
