import { describe, it, expect } from "vitest";
import {
  colorForLabel,
  colorForEdge,
  INFERRED_EDGE_COLOR,
  CONFIRMED_EDGE_COLOR,
} from "./colors";

const HEX = /^#[0-9a-f]{6}$/i;

describe("colorForLabel", () => {
  it("returns a valid hex colour", () => {
    expect(colorForLabel("Issue")).toMatch(HEX);
  });

  it("is deterministic for the same label", () => {
    expect(colorForLabel("Document")).toBe(colorForLabel("Document"));
  });

  it("handles the empty string without throwing", () => {
    expect(colorForLabel("")).toMatch(HEX);
  });

  it("maps distinct labels across more than one palette hue", () => {
    const labels = [
      "Issue",
      "Topic",
      "Person",
      "Document",
      "Project",
      "Commit",
      "Repo",
      "Org",
    ];
    const colors = new Set(labels.map(colorForLabel));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("colorForEdge", () => {
  it("returns the inferred colour for inferred edges", () => {
    expect(colorForEdge(true)).toBe(INFERRED_EDGE_COLOR);
  });

  it("returns the confirmed colour for confirmed edges", () => {
    expect(colorForEdge(false)).toBe(CONFIRMED_EDGE_COLOR);
  });

  it("inferred and confirmed colours differ", () => {
    expect(INFERRED_EDGE_COLOR).not.toBe(CONFIRMED_EDGE_COLOR);
  });
});
