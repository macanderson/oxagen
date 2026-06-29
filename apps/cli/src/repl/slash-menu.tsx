/**
 * slash-menu.tsx — The typeahead dropdown for slash commands.
 *
 * Rendered above the prompt while the user is typing a `/command` token. Each
 * row shows:
 *   - a package glyph (📦) for productized / pre-installed commands; nothing for
 *     user-authored custom commands
 *   - the `/name` and its argument hint
 *   - the full description, wrapped across lines so a long description never gets
 *     truncated into ambiguity (the user must be able to tell commands apart
 *     before selecting one)
 *
 * The highlighted row is marked with a pointer and brightened so it's
 * unmistakable which command Enter/Tab will act on. Long catalogs scroll within a
 * fixed window around the selection.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../tui/theme.js";
import type { SlashCatalogEntry } from "../slash/catalog.js";

/** The package glyph marking a productized (pre-installed) command. */
export const PRODUCTIZED_GLYPH = "📦";
/** Width the custom-command marker reserves so names stay column-aligned. */
const CUSTOM_MARKER = "   ";
/** Max rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_SUGGESTIONS = 6;

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
  /** Outer width in columns; descriptions wrap within it. */
  width?: number;
}): React.ReactElement | null {
  if (entries.length === 0) return null;

  const { start, end } = visibleWindow(entries.length, selectedIndex, MAX_VISIBLE_SUGGESTIONS);
  const visible = entries.slice(start, end);

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
        const marker = entry.productized ? `${PRODUCTIZED_GLYPH} ` : CUSTOM_MARKER;
        return (
          <Box key={entry.name} flexDirection="column">
            <Box>
              <Text color={selected ? theme.cyan : undefined} bold={selected}>
                {selected ? "❯ " : "  "}
              </Text>
              <Text>{marker}</Text>
              <Text bold color={selected ? theme.cyan : theme.violet}>
                /{entry.name}
              </Text>
              {entry.argumentHint ? <Text dimColor> {entry.argumentHint}</Text> : null}
            </Box>
            <Box paddingLeft={4} width={width - 2}>
              <Text dimColor={!selected} wrap="wrap">
                {entry.description}
              </Text>
            </Box>
          </Box>
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
