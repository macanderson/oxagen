import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  Banner,
  WORDMARK,
  WORDMARK_FULL,
  bannerRowCount,
  sunsetColorAt,
} from "../banner.js";

describe("Banner", () => {
  it("renders the wordmark, ring glyph, and version", () => {
    const { lastFrame } = render(<Banner version="0.4.0" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◯");
    expect(frame.toLowerCase()).toContain("oxagen.sh cli");
    expect(frame).toContain("0.4.0");
    expect(frame).toContain("█");
  });

  it("renders the connected org/workspace scope when provided", () => {
    const { lastFrame } = render(
      <Banner version="0.4.0" org="acme" workspace="prod" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("acme");
    expect(frame).toContain("prod");
  });

  it("omits the scope line when org/workspace are absent", () => {
    const { lastFrame } = render(<Banner version="0.4.0" />);
    expect(lastFrame() ?? "").not.toContain("/");
  });

  it("falls back to the compact OXAGEN mark on narrow terminals", () => {
    const { lastFrame } = render(<Banner version="0.4.0" cols={80} />);
    const frame = lastFrame() ?? "";
    // The compact mark still draws block glyphs, but the frame must not be
    // as wide as the full mark. Strip ANSI color codes before measuring —
    // the gradient interleaves an escape per color run.
    expect(frame).toContain("█");
    const plain = frame.replace(/\u001b\[[0-9;]*m/g, "");
    const widest = Math.max(...plain.split("\n").map((l) => l.length));
    expect(widest).toBeLessThan(WORDMARK_FULL[0]!.length);
  });

  it("drops the wordmark entirely when even the compact mark cannot fit", () => {
    const { lastFrame } = render(<Banner version="0.4.0" cols={40} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("█");
    expect(frame.toLowerCase()).toContain("oxagen.sh cli");
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

  it("spells the full mark as constant-width rows", () => {
    expect(WORDMARK_FULL).toHaveLength(5);
    const widths = new Set(WORDMARK_FULL.map((l) => l.length));
    expect(widths.size).toBe(1);
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
  it("budgets wordmark + info lines + margin", () => {
    expect(bannerRowCount(true)).toBe(8);
    expect(bannerRowCount(false)).toBe(7);
  });
});
