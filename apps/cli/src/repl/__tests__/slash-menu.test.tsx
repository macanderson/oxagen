import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { SlashMenu, visibleWindow, MAX_VISIBLE_SUGGESTIONS } from "../slash-menu.js";
import type { SlashCatalogEntry } from "../../slash/catalog.js";

/** Matches an SGR ANSI escape immediately followed by `/name` — i.e. the name
 *  itself is styled (colored and/or bold), not just some other part of the row. */
function colorEscapeBefore(name: string): RegExp {
  return new RegExp(`\\u001b\\[[0-9;]*m/${name}\\b`);
}

const ANSI_ESCAPE = new RegExp("\\u001b\\[[0-9;]*m", "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, "");
}

/** Strips ANSI styling and the box's left/right border verticals from a row,
 *  leaving just that row's content area (for blank-padding-row assertions). */
function innerRowContent(line: string): string {
  return stripAnsi(line).replace(/^│/, "").replace(/│$/, "");
}

const entries: SlashCatalogEntry[] = [
  {
    name: "mode",
    description: "Show or set the permission posture for tool calls",
    argumentHint: "[ask|auto-edit|bypass|readonly]",
    source: "builtin",
    productized: true,
    color: "#60A5FA",
  },
  {
    name: "cost",
    description: "Project model cost from the baked-in rate card",
    source: "cli",
    productized: true,
    // CLI commands are productized but carry no palette color — rendered as
    // default text, same as a custom command.
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

  it("renders a productized command's /name in its own color, and CLI/custom commands as plain default text", () => {
    // Out-of-range selectedIndex: no row is selected, so the only source of
    // styling on /name is the per-command `color` — not the "pop on select"
    // bold that a plain command also gets when it's the active row.
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={entries.length} width={100} />,
    );
    const frame = lastFrame() ?? "";
    // /mode is builtin with an assigned palette color: its /name is styled.
    expect(colorEscapeBefore("mode").test(frame)).toBe(true);
    // /cost is productized (CLI-sourced) but carries no palette color, and
    // /shipit is a non-productized custom command — both render plain.
    expect(colorEscapeBefore("cost").test(frame)).toBe(false);
    expect(colorEscapeBefore("shipit").test(frame)).toBe(false);
  });

  it("keeps the description on the same line as the command and its argument hint", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={0} width={100} />);
    const frame = lastFrame() ?? "";
    const modeLine = frame.split("\n").find((l) => l.includes("/mode")) ?? "";
    expect(modeLine).toContain("[ask|auto-edit|bypass|readonly]");
    expect(modeLine).toContain("Show or set the permission posture for tool calls");
    const shipitLine = frame.split("\n").find((l) => l.includes("/shipit")) ?? "";
    expect(shipitLine).toContain("Open a PR for the current branch");
  });

  it("truncates an overflowing description with an ellipsis instead of wrapping to a new line", () => {
    const long: SlashCatalogEntry = {
      name: "verbose",
      description:
        "Toggle per-phase timing, model+token+cost breakdown, and tool-result telemetry across every running agent",
      argumentHint: "[on|off]",
      source: "builtin",
      productized: true,
      color: "#FBBF24",
    };
    const { lastFrame } = render(<SlashMenu entries={[long]} selectedIndex={0} width={50} />);
    const frame = lastFrame() ?? "";
    const line = frame.split("\n").find((l) => l.includes("/verbose")) ?? "";
    expect(line).toContain("…");
    expect(frame).not.toContain(long.description);
    // Truncation, not wrapping: the description never spills onto its own row.
    expect(frame.split("\n").filter((l) => l.includes("Toggle per-phase"))).toHaveLength(1);
  });

  it("marks the selected row with a pointer", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={1} width={70} />);
    const frame = lastFrame() ?? "";
    const costLine = frame.split("\n").find((l) => l.includes("/cost")) ?? "";
    expect(costLine).toContain("❯");
  });

  it("draws a dim separator between commands but not before the first or after the last", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={0} width={100} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    // Exclude the outer round border's own top/bottom edges (also drawn with
    // "─"), which carry a corner glyph the inter-command separators don't.
    const separators = lines.filter((l) => l.includes("─") && !/[╭╮╰╯]/.test(l));
    expect(separators).toHaveLength(entries.length - 1);
  });

  it("pads each command cell with a blank line above and below its content", () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selectedIndex={0} width={100} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const modeIdx = lines.findIndex((l) => l.includes("/mode"));
    expect(modeIdx).toBeGreaterThan(0);
    // The box's border draws left/right "│" verticals on every row, so a
    // blank padding row isn't an empty string — strip the border first.
    expect(innerRowContent(lines[modeIdx - 1] ?? "").trim()).toBe("");
    expect(innerRowContent(lines[modeIdx + 1] ?? "").trim()).toBe("");
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
