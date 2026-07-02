/**
 * slash-menu.tsx — The typeahead dropdown for slash commands.
 *
 * Rendered above the prompt while the user is typing a `/command` token. Each
 * command is a single-line cell: `❯ /name <args>   description`, with a blank
 * line of padding above and below, and a dim horizontal rule separating one
 * cell from the next. The `❯` pointer appears only on the selected row.
 *
 * Color — not an icon — marks a productized builtin command: its `/name`
 * renders bold in a stable, curated color from `theme.commandPalette` (set on
 * the catalog entry, see slash/catalog.ts). CLI and custom commands carry no
 * `color` and render `/name` as default text. The description is always dim,
 * truncated with an ellipsis so the whole row stays on one line.
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
/** Gap between the command (+ its argument hint) and its description. */
const GAP = "   ";

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

/** Columns consumed by the pointer + `/name` + optional argument hint + gap. */
function prefixWidth(entry: SlashCatalogEntry): number {
  const argWidth = entry.argumentHint ? entry.argumentHint.length + 1 : 0; // +1 leading space
  return POINTER_WIDTH + 1 + entry.name.length + argWidth + GAP.length; // +1 for "/"
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

  const { start, end } = visibleWindow(entries.length, selectedIndex, MAX_VISIBLE_SUGGESTIONS);
  const visible = entries.slice(start, end);
  const innerWidth = Math.max(width - 4, 10); // border (2) + paddingX*2 (2)

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
        const descWidth = Math.max(innerWidth - prefixWidth(entry), 0);
        return (
          <Box key={entry.name} flexDirection="column">
            <Box flexDirection="column" paddingY={1}>
              <Box width={innerWidth}>
                <Text color={selected ? theme.cyan : undefined} bold={selected}>
                  {selected ? "❯ " : "  "}
                </Text>
                <Text bold={Boolean(entry.color) || selected} color={entry.color}>
                  /{entry.name}
                </Text>
                {entry.argumentHint ? <Text dimColor> {entry.argumentHint}</Text> : null}
                <Text>{GAP}</Text>
                {descWidth > 0 ? (
                  <Box width={descWidth}>
                    <Text dimColor wrap="truncate-end">
                      {entry.description}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            </Box>
            {isLast ? null : <Text dimColor>{"─".repeat(innerWidth)}</Text>}
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
