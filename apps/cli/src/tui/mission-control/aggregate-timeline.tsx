/**
 * aggregate-timeline.tsx — the default main pane: every agent's salient lines,
 * merged into one live feed (spec §5).
 *
 * The editorial decision of WHICH events earn a line, and their wording, is the
 * pure `toAggregateLine` formatter (aggregate-line.ts) — this component owns only
 * layout: a `HH:MM:SS` time gutter, the session's short id in its stable color
 * (so a fleet operator tracks each agent by hue), and the line text tinted by
 * emphasis. Beneath the feed sit the pinned live tails — one line per running
 * session showing the last slice of its streaming answer, updating in place —
 * which keep raw text deltas OUT of the merged feed (noise) while still proving
 * each agent is alive and moving.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { shortSid } from "../../sessions/ids.js";
import type { AggregateEmphasis, AggregateLine } from "./aggregate-line.js";
import { colorForSid, formatClock } from "./lib.js";

export interface RenderableLine extends AggregateLine {
  /** Stable, monotonic key for Ink's reconciler (older lines keep their key). */
  key: number;
}

export interface LiveTail {
  sid: string;
  text: string;
}

function emphasisProps(emphasis: AggregateEmphasis): {
  color?: string;
  dimColor?: boolean;
} {
  switch (emphasis) {
    case "dim":
      return { dimColor: true };
    case "success":
      return { color: theme.green };
    case "error":
      return { color: theme.red };
    case "normal":
      return {};
  }
}

// Gutter cells pin flexShrink={0} + truncate: Ink shrinks fixed-width boxes by
// default when a row is tight, wrapping the clock mid-digit instead of
// truncating the one flexible cell — the message text.
function TimelineRow({ line }: { line: RenderableLine }): React.ReactElement {
  return (
    <Box>
      <Box width={9} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {formatClock(line.ts)}
        </Text>
      </Box>
      <Box width={5} flexShrink={0}>
        <Text color={colorForSid(line.sid)} wrap="truncate">
          {shortSid(line.sid)}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>
        <Text {...emphasisProps(line.emphasis)} wrap="truncate-end">
          {line.text}
        </Text>
      </Box>
    </Box>
  );
}

export function AggregateTimeline({
  lines,
  tails,
  rows,
}: {
  lines: readonly RenderableLine[];
  tails: readonly LiveTail[];
  /** Max feed rows the viewport can show; the newest lines win. */
  rows: number;
}): React.ReactElement {
  const feedRows = Math.max(
    1,
    rows - (tails.length > 0 ? tails.length + 1 : 0),
  );
  const visible = lines.slice(-feedRows);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.length === 0 ? (
        <Text dimColor>Waiting for the first agent to speak…</Text>
      ) : (
        visible.map((line) => <TimelineRow key={line.key} line={line} />)
      )}

      {tails.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {tails.map((tail) => (
            <Box key={tail.sid}>
              <Box width={2} flexShrink={0}>
                <Text color={theme.cyan}>⋯</Text>
              </Box>
              <Box width={5} flexShrink={0}>
                <Text color={colorForSid(tail.sid)} wrap="truncate">
                  {shortSid(tail.sid)}
                </Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text dimColor wrap="truncate-start">
                  {tail.text}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
