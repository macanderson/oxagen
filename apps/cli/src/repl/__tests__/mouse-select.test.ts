/**
 * Unit tests for the prompt input's mouse-selection math: the anchor/head
 * selection model (press/drag -> selection, delete/replace), the mouse
 * column -> buffer-offset mapping, and the fullscreen row-geometry anchor.
 * No Ink, no terminal — see mouse-select.ts's own doc comment for why this
 * is pure.
 */
import { describe, it, expect } from "vitest";
import {
  selectionRange,
  hasSelection,
  pressAt,
  dragTo,
  deleteSelectionFrom,
  replaceSelectionWith,
  textStartColumn,
  charOffsetForColumn,
  inputContentRow,
  DOCK_PANEL_HEIGHT,
  type Selection,
} from "../mouse-select.js";

// ── selectionRange / hasSelection ───────────────────────────────────────────

describe("selectionRange", () => {
  it("normalizes a forward drag (anchor before head) unchanged", () => {
    expect(selectionRange({ anchor: 2, head: 5 })).toEqual({
      start: 2,
      end: 5,
    });
  });

  it("normalizes a backward drag (anchor after head)", () => {
    expect(selectionRange({ anchor: 5, head: 2 })).toEqual({
      start: 2,
      end: 5,
    });
  });

  it("collapses a zero-width selection to a single point", () => {
    expect(selectionRange({ anchor: 3, head: 3 })).toEqual({
      start: 3,
      end: 3,
    });
  });
});

describe("hasSelection", () => {
  it("is false for null/undefined", () => {
    expect(hasSelection(null)).toBe(false);
    expect(hasSelection(undefined)).toBe(false);
  });

  it("is false for a zero-width selection (a plain click, no drag)", () => {
    expect(hasSelection({ anchor: 4, head: 4 })).toBe(false);
  });

  it("is true for any non-zero-width selection, either direction", () => {
    expect(hasSelection({ anchor: 1, head: 4 })).toBe(true);
    expect(hasSelection({ anchor: 4, head: 1 })).toBe(true);
  });
});

// ── press / drag ─────────────────────────────────────────────────────────────

describe("pressAt", () => {
  it("starts a collapsed selection at the clicked offset", () => {
    const sel = pressAt(7);
    expect(sel).toEqual({ anchor: 7, head: 7 });
    expect(hasSelection(sel)).toBe(false);
  });
});

describe("dragTo", () => {
  it("extends the head while keeping the original anchor", () => {
    const pressed = pressAt(3);
    const dragged = dragTo(pressed, 9);
    expect(dragged).toEqual({ anchor: 3, head: 9 });
  });

  it("a drag back past the anchor still keeps the SAME anchor (selection just flips direction)", () => {
    const pressed = pressAt(5);
    const draggedLeft = dragTo(pressed, 1);
    expect(draggedLeft).toEqual({ anchor: 5, head: 1 });
    expect(selectionRange(draggedLeft)).toEqual({ start: 1, end: 5 });
  });

  it("a full press -> drag -> drag -> release-equivalent sequence lands on the right range", () => {
    let sel = pressAt(2);
    sel = dragTo(sel, 6);
    sel = dragTo(sel, 10); // still dragging — extends further
    expect(selectionRange(sel)).toEqual({ start: 2, end: 10 });
  });
});

// ── deleteSelectionFrom / replaceSelectionWith ──────────────────────────────

describe("deleteSelectionFrom", () => {
  it("removes the selected range and leaves the cursor at its start", () => {
    // "hello world"[2,5) === "llo" -> removed leaves "he" + " world".
    const sel: Selection = { anchor: 2, head: 5 };
    const result = deleteSelectionFrom("hello world", sel);
    expect(result.text).toBe("he world");
    expect(result.cursorPos).toBe(2);
  });

  it("removes exactly the [start, end) slice — verified index by index", () => {
    // "abcdef", selection [1,4) = "bcd" removed -> "aef"
    const result = deleteSelectionFrom("abcdef", { anchor: 1, head: 4 });
    expect(result.text).toBe("aef");
    expect(result.cursorPos).toBe(1);
  });

  it("works the same regardless of drag direction (backward selection)", () => {
    const forward = deleteSelectionFrom("abcdef", { anchor: 1, head: 4 });
    const backward = deleteSelectionFrom("abcdef", { anchor: 4, head: 1 });
    expect(forward).toEqual(backward);
  });

  it("a zero-width selection deletes nothing (no-op on text, cursor stays put)", () => {
    const result = deleteSelectionFrom("abcdef", { anchor: 3, head: 3 });
    expect(result.text).toBe("abcdef");
    expect(result.cursorPos).toBe(3);
  });
});

describe("replaceSelectionWith", () => {
  it("replaces the selected range with the inserted text, cursor after the insert", () => {
    // "abcdef", selection [1,4) = "bcd" -> replace with "XY" -> "aXYef"
    const result = replaceSelectionWith("abcdef", { anchor: 1, head: 4 }, "XY");
    expect(result.text).toBe("aXYef");
    expect(result.cursorPos).toBe(3); // right after "XY"
  });

  it("typing a single character over a selection behaves like backspace-then-type", () => {
    const result = replaceSelectionWith(
      "hello world",
      { anchor: 0, head: 5 },
      "goodbye",
    );
    expect(result.text).toBe("goodbye world");
    expect(result.cursorPos).toBe(7);
  });

  it("replacing with an empty string is equivalent to deleteSelectionFrom", () => {
    const sel: Selection = { anchor: 1, head: 4 };
    const replaced = replaceSelectionWith("abcdef", sel, "");
    const deleted = deleteSelectionFrom("abcdef", sel);
    expect(replaced).toEqual(deleted);
  });
});

// ── charOffsetForColumn / textStartColumn ───────────────────────────────────

describe("textStartColumn", () => {
  it("computes 1 border + 1 padding + the glyph width, +1 to land on the first text column", () => {
    // The real glyphs ("❯ ", "⧗ ", "$ ") are all exactly 2 chars.
    expect(textStartColumn(2)).toBe(5);
  });

  it("scales with a hypothetical wider/narrower glyph", () => {
    expect(textStartColumn(1)).toBe(4);
    expect(textStartColumn(4)).toBe(7);
  });
});

describe("charOffsetForColumn", () => {
  const textStartCol = textStartColumn(2); // = 5, matching the real glyphs

  it("maps the column of the first character to offset 0", () => {
    expect(charOffsetForColumn(textStartCol, textStartCol, 10)).toBe(0);
  });

  it("maps each subsequent column to the next offset", () => {
    expect(charOffsetForColumn(textStartCol + 3, textStartCol, 10)).toBe(3);
  });

  it("clamps a click in the border/padding/glyph area (left of the text) to offset 0", () => {
    expect(charOffsetForColumn(1, textStartCol, 10)).toBe(0); // on the border itself
    expect(charOffsetForColumn(textStartCol - 1, textStartCol, 10)).toBe(0); // on the glyph
  });

  it("clamps a click past the last character to textLength", () => {
    expect(charOffsetForColumn(textStartCol + 999, textStartCol, 10)).toBe(10);
  });

  it("a click exactly one past the last character lands at textLength (append position)", () => {
    expect(charOffsetForColumn(textStartCol + 10, textStartCol, 10)).toBe(10);
  });
});

// ── inputContentRow ──────────────────────────────────────────────────────────

describe("inputContentRow", () => {
  it("computes the content row purely from terminal height and the fixed dock/input chrome", () => {
    // rows=20: dock block (DOCK_PANEL_HEIGHT + 1 margin = 7) occupies 14..20;
    // input block (3 rows) occupies 11..13 -> content row = 12.
    expect(inputContentRow(20)).toBe(12);
  });

  it("scales linearly with terminal height (a taller terminal pushes the row down by the same delta)", () => {
    const base = inputContentRow(30);
    expect(inputContentRow(40)).toBe(base + 10);
    expect(inputContentRow(20)).toBe(base - 10);
  });

  it("sits exactly one row above the input's own bottom border, which sits exactly DOCK_PANEL_HEIGHT+1 (dock + its margin) rows above the terminal's last row", () => {
    const rows = 50;
    const dockBlockHeight = DOCK_PANEL_HEIGHT + 1; // dock panels + the Box's marginBottom={1}
    const inputBottomBorderRow = rows - dockBlockHeight;
    expect(inputContentRow(rows)).toBe(inputBottomBorderRow - 1);
  });
});
