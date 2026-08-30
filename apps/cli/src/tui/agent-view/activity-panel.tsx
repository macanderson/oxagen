/**
 * Activity Panel — the most recent salient lines from the newest run's REAL
 * event log, folded through the same aggregate-timeline rules Mission Control
 * uses. This is a retrospective peek, not a live follow: for a live stream,
 * `oxagen fleet watch` / Mission Control is the surface.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { colorForSid, formatClock } from "../mission-control/lib.js";
import type { AggregateEmphasis } from "../mission-control/aggregate-line.js";
import type { ActivityLine } from "./data.js";

function emphasisColor(emphasis: AggregateEmphasis): string | undefined {
  switch (emphasis) {
    case "success":
      return theme.green;
    case "error":
      return theme.red;
    case "dim":
      return theme.dim;
    case "normal":
      return undefined;
  }
}

export function ActivityPanel({
  lines,
}: {
  lines: ActivityLine[];
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text bold color={theme.amber}>
            ◈ RECENT ACTIVITY
          </Text>
          <Text dimColor> · newest run</Text>
        </Box>
        <Text dimColor>live: oxagen fleet watch</Text>
      </Box>

      {lines.length === 0 ? (
        <Text dimColor>No recorded events yet.</Text>
      ) : (
        lines.map((l, i) => (
          <Box key={i} gap={1}>
            <Text dimColor>{formatClock(l.ts)}</Text>
            <Text color={colorForSid(l.sid)}>▏</Text>
            <Box flexGrow={1}>
              <Text
                color={emphasisColor(l.emphasis)}
                dimColor={l.emphasis === "dim"}
                wrap="truncate"
              >
                {l.text}
              </Text>
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}
