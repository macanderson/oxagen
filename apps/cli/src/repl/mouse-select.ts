/**
 * Pure mouse-to-buffer mapping + selection math for the prompt input's
 * Claude-Code-style click/drag text editing: press positions the cursor,
 * drag extends a selection, and the selected range is what Backspace/Delete/
 * typing act on (see components.tsx's PromptInput, which owns the actual
 * mouse listener via use-mouse-select.ts and calls into these). Framework-
 * free and fully unit-testable — no Ink, no terminal, no timers — same
 * philosophy as scroll.ts / telemetry.ts / border-phase.ts.
 *
 * LIMITATION — scoped to the SINGLE-LINE case (the common one: most prompts
 * are one line). A buffer that word-wraps to multiple visual rows, or holds
 * an explicit newline (Ctrl-J), still maps a click's column against the
 * FIRST row's text only — clicking into a wrapped/later line degrades to
 * landing at the nearest end of that first row rather than the exact
 * character under the cursor. Precise multi-line coordinate mapping would
 * need to know Ink's own word-wrap breakpoints, which aren't exposed by its
 * public API; single-line correctness was prioritized over that.
 */

// ── Selection ────────────────────────────────────────────────────────────────

export interface Selection {
  /** Character offset where the drag started. */
  anchor: number;
  /** Character offset the drag is currently at — also where the caret shows. */
  head: number;
}

/** Normalized `[start, end)` range, regardless of which direction the drag ran. */
export function selectionRange(sel: Selection): { start: number; end: number } {
  return sel.anchor <= sel.head
    ? { start: sel.anchor, end: sel.head }
    : { start: sel.head, end: sel.anchor };
}

/**
 * True for a selection spanning at least one character. A plain click (press
 * with no subsequent drag) collapses anchor === head — that's a normal
 * cursor placement, not a highlighted selection, so callers should treat it
 * the same as no selection at all for rendering and delete/replace purposes.
 */
export function hasSelection(
  sel: Selection | null | undefined,
): sel is Selection {
  if (!sel) return false;
  const { start, end } = selectionRange(sel);
  return end > start;
}

/** Press: start a fresh, collapsed selection at the clicked offset (clears whatever selection existed before). */
export function pressAt(offset: number): Selection {
  return { anchor: offset, head: offset };
}

/** Drag: extend the LIVE selection's head to the new offset — the anchor stays put for the whole drag. */
export function dragTo(sel: Selection, offset: number): Selection {
  return { anchor: sel.anchor, head: offset };
}

/**
 * Delete the selected range out of `text`. Cursor lands at the range's
 * start — where the deleted text used to begin, matching how Backspace/
 * Delete already position the cursor on a single-character delete.
 */
export function deleteSelectionFrom(
  text: string,
  sel: Selection,
): { text: string; cursorPos: number } {
  const { start, end } = selectionRange(sel);
  return { text: text.slice(0, start) + text.slice(end), cursorPos: start };
}

/**
 * Replace the selected range with `insert` (typing, paste, or an image-paste
 * token over an active selection). Cursor lands immediately after the
 * inserted text, matching plain (no-selection) insertion.
 */
export function replaceSelectionWith(
  text: string,
  sel: Selection,
  insert: string,
): { text: string; cursorPos: number } {
  const { start, end } = selectionRange(sel);
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    cursorPos: start + insert.length,
  };
}

// ── Mouse column -> buffer offset (single-line) ─────────────────────────────

/**
 * Fixed chrome to the LEFT of the buffer text inside the input's bordered
 * box: 1 border column + 1 paddingX column + the glyph's own width (the
 * glyph — "❯ ", "⧗ ", "$ " — is always exactly 2 characters; pass its actual
 * length rather than hardcoding 2 so a future glyph change can't silently
 * desync this math). Returns the 1-based screen column of the buffer's first
 * character, given the box's own left edge is screen column 1 — true in both
 * the fullscreen and classic layouts, since neither wraps PromptInput in a
 * left-margined container (see interactive.tsx).
 */
export function textStartColumn(glyphWidth: number): number {
  const BORDER_WIDTH = 1;
  const PADDING_X = 1;
  return BORDER_WIDTH + PADDING_X + glyphWidth + 1;
}

/**
 * Maps a 1-based terminal column to a character offset into a `textLength`-
 * long single line, given the screen column its first character renders at
 * (`textStartCol`, from {@link textStartColumn}). A click left of the text
 * (on the border/padding/glyph) clamps to offset 0; a click past the last
 * character clamps to `textLength` — so a click ANYWHERE on the input's row
 * lands somewhere sane rather than being silently dropped.
 */
export function charOffsetForColumn(
  col: number,
  textStartCol: number,
  textLength: number,
): number {
  return Math.max(0, Math.min(textLength, col - textStartCol));
}

// ── Row geometry (fullscreen layout only) ───────────────────────────────────

/**
 * Row height of one TelemetryDock panel (fullscreen-chrome.tsx's DockPanel).
 * Defined HERE rather than in fullscreen-chrome.tsx and imported the other
 * way around — fullscreen-chrome.tsx already imports from components.tsx,
 * and components.tsx needs this module for its own mouse-selection logic, so
 * fullscreen-chrome.tsx -> mouse-select.ts -> components.tsx would cycle back
 * on itself. Keeping the constant on this (leaf, dependency-free) module and
 * having fullscreen-chrome.tsx import it from here avoids that cycle. Keep
 * this in sync with DockPanel's own `height` prop.
 */
export const DOCK_PANEL_HEIGHT = 6;

/**
 * 1-based terminal row of the prompt input's single content line, in the
 * fullscreen TUI layout — anchored from the BOTTOM of the frame rather than
 * counted down from the top, because the TelemetryDock (a fixed
 * {@link DOCK_PANEL_HEIGHT} rows + a 1-row margin) is the ONE thing below the
 * input whose height never varies with conditional banners (queued prompts,
 * the reset-confirm prompt, the HUD, a drilled-in agent log, …) — see
 * interactive.tsx's `fullscreen` render branch, where the input row and the
 * dock row are adjacent siblings with nothing flexible between them. Counting
 * up from a fixed anchor is robust to all of that variable content above the
 * input; counting DOWN from the top would have to account for every one of
 * those conditionals individually.
 *
 * LIMITATION: assumes the input's own bordered box is exactly 3 rows. An open
 * slash-menu is fine (it renders ABOVE the border box, which doesn't move the
 * box's own BOTTOM edge relative to the dock below it) — but the `!command`
 * terminal-mode hint banner renders BELOW the border box and would throw this
 * off by one row. Mouse selection degrades gracefully there (offsets land a
 * row off) rather than being exactly right, matching this feature's
 * documented single-line/common-case scope.
 */
export function inputContentRow(terminalRows: number): number {
  const DOCK_MARGIN_BOTTOM = 1; // interactive.tsx wraps <TelemetryDock> in a Box with marginBottom={1}
  const INPUT_BOX_HEIGHT = 3; // top border + content + bottom border
  const dockBlockHeight = DOCK_PANEL_HEIGHT + DOCK_MARGIN_BOTTOM;
  const inputBottomBorderRow = terminalRows - dockBlockHeight;
  const inputTopBorderRow = inputBottomBorderRow - (INPUT_BOX_HEIGHT - 1);
  return inputTopBorderRow + 1; // skip the top border row itself — this IS the content row
}
