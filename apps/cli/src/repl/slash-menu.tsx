/**
 * slash-menu.tsx — The typeahead dropdown for slash commands.
 *
 * Rendered above the prompt while the user is typing a `/command` token. Every
 * command is a fixed two-line cell — a command line (`<pointer><lock> /name
 * <args>`) followed by a description line — with exactly one blank line
 * between cells and no rule. Height never varies: the description is
 * truncated to a single line with an ellipsis instead of wrapping, and
 * selecting a row only swaps the pointer glyph in place, so navigating and
 * scrolling never reflow the list.
 *
 * `/name` always renders bold amber; an argument hint renders green; the
 * description is plain, default-color text (no dim). All argument hints and
 * descriptions line up on one fixed column (`argCol`), sized to the widest
 * `/name` currently on screen. A productized (first-party) command carries a
 * monochrome lock marker — `\u{1F512}︎`, the *text*-presentation glyph,
 * not a color emoji — in a reserved column so custom commands' `/name` still
 * lines up with it.
 *
 * Long catalogs scroll within a fixed window around the selection.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../tui/theme.js";
import type { SlashCatalogEntry } from "../slash/catalog.js";

/** Max rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_SUGGESTIONS = 6;

/** Width the `❯ ` pointer column reserves so names stay aligned when absent. */
const POINTER_WIDTH = 2;
/**
 * Monochrome productized marker: the lock glyph plus U+FE0E (VARIATION
 * SELECTOR-15), which forces the single-color *text* presentation instead of
 * the full-color emoji glyph.
 */
const LOCK = "\u{1F512}︎";
/** Width the lock column reserves — measured against how Ink itself sizes
 *  `LOCK` (2 columns), so a blank placeholder of the same width keeps a
 *  custom command's `/name` aligned with a productized one either way. */
const LOCK_COL_WIDTH = 2;
/** Columns before `/name` starts: the pointer column plus the lock column. */
const PREFIX_WIDTH = POINTER_WIDTH + LOCK_COL_WIDTH;
/** Gap between the (padded) command name column and its argument hint / description column. */
const GAP_WIDTH = 2;

/** Compute the [start, end) slice of a list that keeps `selected` in view. */
export function visibleWindow(
  total: number,
  selected: number,
  max: number,
): { start: number; end: number } {
  if (total <= max) return { start: 0, end: total };
  const half = Math.floor(max / 2);
  const start = Math.min(Math.max(0, selected - half), total - max);
  return { start, end: start + max };
}

export function SlashMenu({
  entries,
  selectedIndex,
  width = 72,
}: {
  entries: ReadonlyArray<SlashCatalogEntry>;
  selectedIndex: number;
  /** Outer width in columns; rows and separators fit within it. */
  width?: number;
}): React.ReactElement | null {
  if (entries.length === 0) return null;

  const { start, end } = visibleWindow(
    entries.length,
    selectedIndex,
    MAX_VISIBLE_SUGGESTIONS,
  );
  const visible = entries.slice(start, end);
  const innerWidth = Math.max(width - 4, 10); // border (2) + paddingX*2 (2)

  // Fixed column every visible row's args + description align to, sized to
  // the widest `/name` currently on screen (recomputed as the window
  // scrolls, so it never depends on off-screen entries).
  const maxNameWidth = Math.max(
    ...visible.map((entry) => entry.name.length + 1),
  ); // +1 for "/"
  const argCol = PREFIX_WIDTH + maxNameWidth + GAP_WIDTH;
  const descWidth = Math.max(innerWidth - argCol, 0);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      width={width}
    >
      {visible.map((entry, i) => {
        const idx = start + i;
        const selected = idx === selectedIndex;
        const isLast = i === visible.length - 1;
        const namePad = maxNameWidth - (entry.name.length + 1);
        return (
          // Two fixed-height lines per cell (command + description) plus a
          // single blank separator — never a rule, never conditional on
          // `selected`, so every cell occupies the same number of rows.
          <React.Fragment key={entry.name}>
            <Box flexDirection="column">
              <Box width={innerWidth}>
                <Text color={selected ? theme.cyan : undefined} bold={selected}>
                  {selected ? "❯ " : "  "}
                </Text>
                <Box width={LOCK_COL_WIDTH}>
                  <Text dimColor>{entry.productized ? LOCK : ""}</Text>
                </Box>
                <Text color={theme.amber} bold>
                  /{entry.name}
                </Text>
                {entry.argumentHint ? (
                  <>
                    <Text>{" ".repeat(namePad + GAP_WIDTH)}</Text>
                    <Text color={theme.green}>{entry.argumentHint}</Text>
                  </>
                ) : null}
              </Box>
              <Box width={innerWidth}>
                <Text>{" ".repeat(argCol)}</Text>
                {descWidth > 0 ? (
                  <Box width={descWidth}>
                    <Text wrap="truncate-end">{entry.description}</Text>
                  </Box>
                ) : null}
              </Box>
            </Box>
            {isLast ? null : <Text> </Text>}
          </React.Fragment>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {entries.length > MAX_VISIBLE_SUGGESTIONS
            ? `${selectedIndex + 1}/${entries.length} · `
            : ""}
          ↑↓ navigate · ⇥ complete · ↵ run · esc dismiss
        </Text>
      </Box>
    </Box>
  );
}
