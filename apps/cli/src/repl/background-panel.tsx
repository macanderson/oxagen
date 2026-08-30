/**
 * background-panel.tsx — the compact "Background dispatches" dock panel
 * (docs/specs/repl-async-dispatch.md §2.2).
 *
 * Presentational and prop-driven (same philosophy as fullscreen-chrome.tsx):
 * one row per dispatch this REPL spawned, fed by `createBackgroundTracker`'s
 * roster. Rows are non-focus-stealing — they never grab the cursor or the
 * composer; the panel simply renders below the transcript while the user keeps
 * typing. Cited by short sid + title (never a raw UUID), with live stage/cost.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../tui/theme.js";
import { shortSid } from "../sessions/ids.js";
import type { BackgroundRow } from "./background-tracker.js";

/** Glyph + color for a row's lifecycle state. */
function stateGlyph(state: BackgroundRow["state"]): {
  glyph: string;
  color: string;
} {
  switch (state) {
    case "done":
      return { glyph: "✓", color: theme.green };
    case "failed":
    case "orphaned":
      return { glyph: "✗", color: theme.red };
    case "cancelled":
      return { glyph: "◌", color: theme.dim };
    default:
      // queued | running | waiting
      return { glyph: "●", color: theme.cyan };
  }
}

/** True while a dispatch can still emit events. */
function isRunning(state: BackgroundRow["state"]): boolean {
  return state === "queued" || state === "running" || state === "waiting";
}

function BackgroundRowView({
  row,
}: {
  row: BackgroundRow;
}): React.ReactElement {
  const { glyph, color } = stateGlyph(row.state);
  return (
    <Box>
      <Box width={2}>
        <Text color={color}>{glyph}</Text>
      </Box>
      <Box width={5}>
        <Text color={theme.violet}>{shortSid(row.sid)}</Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap="truncate-end">{row.title}</Text>
        {row.detail ? (
          <Text dimColor wrap="truncate-end">
            {"  "}
            {row.detail}
          </Text>
        ) : null}
      </Box>
      {row.costUsd > 0 ? (
        <Box marginLeft={1}>
          <Text color={theme.green}>{`$${row.costUsd.toFixed(2)}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * The Background dispatches panel. Renders nothing when there are no tracked
 * dispatches, so it costs zero rows until the first one is spawned.
 */
export function BackgroundPanel({
  rows,
}: {
  rows: readonly BackgroundRow[];
}): React.ReactElement | null {
  if (rows.length === 0) return null;
  const running = rows.filter((r) => isRunning(r.state)).length;
  const done = rows.length - running;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
    >
      <Box>
        <Text color={theme.violet} bold>
          {"⇉ Background "}
        </Text>
        <Text dimColor>{`(${running} running · ${done} done)`}</Text>
      </Box>
      <Box flexDirection="column">
        {rows.map((row) => (
          <BackgroundRowView key={row.sid} row={row} />
        ))}
      </Box>
    </Box>
  );
}
