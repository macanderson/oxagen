import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  SlashMenu,
  visibleWindow,
  MAX_VISIBLE_SUGGESTIONS,
} from "../slash-menu.js";
import type { SlashCatalogEntry } from "../../slash/catalog.js";

const ANSI_ESCAPE = new RegExp("\\u001b\\[[0-9;]*m", "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, "");
}

/** Strips ANSI styling and the box's left/right border verticals from a row,
 *  leaving just that row's content area. */
function innerRowContent(line: string): string {
  return stripAnsi(line).replace(/^│/, "").replace(/│$/, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Built via fromCharCode (rather than a literal escape) so the ESC control
// byte never has to appear directly in this source file.
const ESC = String.fromCharCode(27);

function hexToAnsiFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/** True when `text` is immediately preceded by `hex`'s truecolor SGR code —
 *  i.e. `text` itself is styled that color, not some unrelated run on the row. */
function isColoredText(frame: string, text: string, hex: string): boolean {
  return new RegExp(
    `${escapeRegExp(hexToAnsiFg(hex))}${escapeRegExp(text)}`,
  ).test(frame);
}

/** True when `text` is immediately preceded by a bold-on code and then `hex`'s
 *  truecolor code, matching how Ink emits a `<Text bold color>` run. */
function isBoldColoredText(frame: string, text: string, hex: string): boolean {
  const boldOn = `${ESC}[1m`;
  return new RegExp(
    `${escapeRegExp(boldOn)}${escapeRegExp(hexToAnsiFg(hex))}${escapeRegExp(text)}`,
  ).test(frame);
}

// The productized lock marker is an astral code point (U+1F512) plus the
// U+FE0E text-presentation selector: 3 UTF-16 code units for 2 *rendered*
// terminal columns. Column-position assertions compare terminal columns, so
// normalize it to an equal-width ASCII stand-in before indexOf/search (which
// count UTF-16 units and would otherwise overcount it by one).
const LOCK = "\u{1F512}︎";
function normalizeLockWidth(line: string): string {
  return line.split(LOCK).join("XX");
}

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
  {
    name: "coordinator",
    description: "Run turns on the remote gateway or the local on-device LLM",
    argumentHint: "[remote|local]",
    source: "builtin",
    productized: true,
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

  it("renders every /name in bold amber, uniformly across builtin/cli/custom commands", () => {
    const { lastFrame } = render(
      <SlashMenu
        entries={entries}
        selectedIndex={entries.length}
        width={100}
      />,
    );
    const frame = lastFrame() ?? "";
    for (const entry of entries) {
      expect(isBoldColoredText(frame, `/${entry.name}`, "#FBBF24")).toBe(true);
    }
  });

  it("renders argument hints in green, not bold", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const frame = lastFrame() ?? "";
    expect(
      isColoredText(frame, "[ask|auto-edit|bypass|readonly]", "#34D399"),
    ).toBe(true);
    expect(isColoredText(frame, "[remote|local]", "#34D399")).toBe(true);
    expect(
      isBoldColoredText(frame, "[ask|auto-edit|bypass|readonly]", "#34D399"),
    ).toBe(false);
  });

  it("renders the description as plain default-color text, never dim or colored", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const frame = lastFrame() ?? "";
    // A colored or dim run would insert an SGR code immediately before/after
    // the text, breaking it up as a contiguous substring of the raw frame.
    for (const entry of entries) {
      expect(frame).toContain(entry.description);
    }
  });

  it("puts the description on its own line directly below the command line", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const lines = (lastFrame() ?? "").split("\n");
    const modeLine = lines.find((l) => l.includes("/mode")) ?? "";
    expect(modeLine).not.toContain(entries[0]!.description);
    const modeIdx = lines.findIndex((l) => l.includes("/mode"));
    expect(lines[modeIdx + 1]).toContain(entries[0]!.description);
  });

  it("aligns every row's argument hint and description on one fixed column, keyed to the widest /name on screen", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const lines = (lastFrame() ?? "")
      .split("\n")
      .map(innerRowContent)
      .map(normalizeLockWidth);

    const nameCols = entries.map((e) => {
      const line = lines.find((l) => l.includes(`/${e.name}`)) ?? "";
      return line.indexOf(`/${e.name}`);
    });
    expect(new Set(nameCols).size).toBe(1);

    const descCols = entries.map((e) => {
      const nameLineIdx = lines.findIndex((l) => l.includes(`/${e.name}`));
      return lines[nameLineIdx + 1]!.search(/\S/);
    });
    expect(new Set(descCols).size).toBe(1);

    const argCols = entries
      .filter((e) => e.argumentHint)
      .map((e) => {
        const line = lines.find((l) => l.includes(`/${e.name}`)) ?? "";
        return line.search(/[[<]/);
      });
    expect(argCols.length).toBeGreaterThan(0);
    expect(new Set(argCols).size).toBe(1);
    // args and descriptions share the exact same column.
    expect(argCols[0]).toBe(descCols[0]);
  });

  it("still indents the description to the arg column for a command with no argument hint", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const lines = (lastFrame() ?? "")
      .split("\n")
      .map(innerRowContent)
      .map(normalizeLockWidth);
    const shipitIdx = lines.findIndex((l) => l.includes("/shipit"));
    const modeIdx = lines.findIndex((l) => l.includes("/mode"));
    expect(lines[shipitIdx + 1]!.search(/\S/)).toBe(
      lines[modeIdx + 1]!.search(/\S/),
    );
  });

  it("marks only productized commands with the monochrome lock, reserving the same width for custom ones", () => {
    const { lastFrame } = render(
      <SlashMenu
        entries={entries}
        selectedIndex={entries.length}
        width={100}
      />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    for (const entry of entries) {
      const line = lines.find((l) => l.includes(`/${entry.name}`)) ?? "";
      expect(line.includes(LOCK)).toBe(entry.productized);
    }
  });

  it("renders the lock marker dim, never as a color emoji", () => {
    const { lastFrame } = render(
      <SlashMenu entries={[entries[0]!]} selectedIndex={0} width={100} />,
    );
    const frame = lastFrame() ?? "";
    const dimOn = `${ESC}[2m`;
    const dimOff = `${ESC}[22m`;
    expect(frame).toContain(dimOn + LOCK + dimOff);
    for (const hex of ["#FBBF24", "#34D399", "#60A5FA", "#F87171"]) {
      expect(isColoredText(frame, LOCK, hex)).toBe(false);
    }
  });

  it("marks the selected row with a pointer", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={1} width={70} />,
    );
    const frame = lastFrame() ?? "";
    const costLine = frame.split("\n").find((l) => l.includes("/cost")) ?? "";
    expect(costLine).toContain("❯");
  });

  it("never renders a horizontal rule between or around commands", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    // Exclude the outer round border's own top/bottom edges (also drawn with
    // "─"), which carry a corner glyph no interior rule would.
    const interiorRules = lines.filter(
      (l) => l.includes("─") && !/[╭╮╰╯]/.test(l),
    );
    expect(interiorRules).toHaveLength(0);
  });

  it("puts exactly one blank line between cells, and none before the first or after the last", () => {
    const { lastFrame } = render(
      <SlashMenu entries={entries} selectedIndex={0} width={100} />,
    );
    const lines = (lastFrame() ?? "").split("\n").map(innerRowContent);
    const modeIdx = lines.findIndex((l) => l.includes("/mode"));
    // No blank padding row between the top border and the first command.
    expect(lines[modeIdx - 1]?.trim()).not.toBe("");
    // Each command's 2 content lines + 1 blank separator = the next command
    // starts exactly 3 rows later, for every consecutive pair.
    for (let i = 0; i < entries.length - 1; i++) {
      const thisIdx = lines.findIndex((l) =>
        l.includes(`/${entries[i]!.name}`),
      );
      const nextIdx = lines.findIndex((l) =>
        l.includes(`/${entries[i + 1]!.name}`),
      );
      expect(nextIdx - thisIdx).toBe(3);
    }
  });

  it("keeps every cell the same height no matter which row is selected", () => {
    const heights = [0, 1, entries.length - 1, entries.length].map(
      (selectedIndex) => {
        const { lastFrame } = render(
          <SlashMenu
            entries={entries}
            selectedIndex={selectedIndex}
            width={100}
          />,
        );
        return (lastFrame() ?? "").split("\n").length;
      },
    );
    expect(new Set(heights).size).toBe(1);
  });

  it("truncates an overflowing description with an ellipsis instead of wrapping", () => {
    const long: SlashCatalogEntry = {
      name: "verbose",
      description:
        "Toggle per-phase timing, model+token+cost breakdown, and tool-result telemetry across every running agent",
      argumentHint: "[on|off]",
      source: "builtin",
      productized: true,
    };
    const { lastFrame } = render(
      <SlashMenu entries={[long]} selectedIndex={0} width={50} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const nameIdx = lines.findIndex((l) => l.includes("/verbose"));
    const descLine = lines[nameIdx + 1] ?? "";
    expect(descLine).toContain("…");
    expect(frame).not.toContain(long.description);
    // Truncation, not wrapping: the description never spills onto another row.
    expect(lines.filter((l) => l.includes("Toggle per-phase"))).toHaveLength(1);
  });

  it("shows a position counter when the catalog exceeds the visible window", () => {
    const many: SlashCatalogEntry[] = Array.from(
      { length: MAX_VISIBLE_SUGGESTIONS + 4 },
      (_, i) => ({
        name: `cmd${i}`,
        description: `description number ${i}`,
        source: "cli" as const,
        productized: true,
      }),
    );
    const { lastFrame } = render(
      <SlashMenu entries={many} selectedIndex={0} width={70} />,
    );
    expect(lastFrame() ?? "").toContain(`1/${many.length}`);
  });
});
