import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  SlashMenu,
  visibleWindow,
  PRODUCTIZED_GLYPH,
  MAX_VISIBLE_SUGGESTIONS,
} from "../slash-menu.js";
import type { SlashCatalogEntry } from "../../slash/catalog.js";

const entries: SlashCatalogEntry[] = [
  {
    name: "mode",
    description: "Show or set the permission posture for tool calls",
    argumentHint: "[ask|auto-edit|bypass|readonly]",
    source: "builtin",
    productized: true,
  },
  {
    name: "cost",
    description: "Project model cost from the baked-in rate card",
    source: "cli",
    productized: true,
  },
  {
    name: "shipit",
    description: "Open a PR for the current branch",
    source: "custom",
    productized: false,
  },
];

describe("visibleWindow", () => {
  it("returns the whole range when it fits", () => {
    expect(visibleWindow(3, 0, 6)).toEqual({ start: 0, end: 3 });
  });

  it("scrolls to keep the selection centered without overrunning the ends", () => {
    expect(visibleWindow(20, 0, 6)).toEqual({ start: 0, end: 6 });
    expect(visibleWindow(20, 19, 6)).toEqual({ start: 14, end: 20 });
    const mid = visibleWindow(20, 10, 6);
    expect(mid.end - mid.start).toBe(6);
    expect(mid.start).toBeLessThanOrEqual(10);
    expect(mid.end).toBeGreaterThan(10);
  });
});

describe("SlashMenu", () => {
  it("renders nothing when there are no entries", () => {
    const { lastFrame } = render(<SlashMenu entries={[]} selectedIndex={0} />);
    expect(lastFrame()).toBe("");
  });

  it("shows the package glyph for productized commands and none for custom", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={0} width={70} />);
    const frame = lastFrame() ?? "";
    // Productized rows carry the glyph; the custom row's /shipit does not.
    expect(frame).toContain(PRODUCTIZED_GLYPH);
    const shipitLine = frame.split("\n").find((l) => l.includes("/shipit")) ?? "";
    expect(shipitLine).not.toContain(PRODUCTIZED_GLYPH);
  });

  it("displays a description and the argument hint for each command", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={0} width={70} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/mode");
    expect(frame).toContain("[ask|auto-edit|bypass|readonly]");
    expect(frame).toContain("Project model cost");
    expect(frame).toContain("Open a PR for the current branch");
  });

  it("marks the selected row with a pointer", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={1} width={70} />);
    const frame = lastFrame() ?? "";
    const costLine = frame.split("\n").find((l) => l.includes("/cost")) ?? "";
    expect(costLine).toContain("❯");
  });

  it("shows a position counter when the catalog exceeds the visible window", () => {
    const many: SlashCatalogEntry[] = Array.from({ length: MAX_VISIBLE_SUGGESTIONS + 4 }, (_, i) => ({
      name: `cmd${i}`,
      description: `description number ${i}`,
      source: "cli" as const,
      productized: true,
    }));
    const { lastFrame } = render(<SlashMenu entries={many} selectedIndex={0} width={70} />);
    expect(lastFrame() ?? "").toContain(`1/${many.length}`);
  });
});
