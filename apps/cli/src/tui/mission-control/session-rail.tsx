/**
 * session-rail.tsx — the left column of Mission Control (spec §5).
 *
 * One row per session in the fleet, newest first: a state glyph, the short id
 * (in the session's stable color, matching its timeline gutter), a clipped
 * title, and a right-aligned live elapsed clock (active) or dollar cost. The
 * selected row is marked and brightened; selection is driven from the parent
 * (tab / arrows / digit-jump) so the rail itself stays presentational.
 *
 * Hidden entirely when the roster is empty — the empty state lives in the main
 * pane, so the composer isn't crowded by a blank column on first launch.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatUsd } from "../../agent/model-router.js";
import { shortSid } from "../../sessions/ids.js";
import { isActiveState, type SessionMetaView } from "../../sessions/store.js";
import { colorForSid, formatElapsed, stateGlyph } from "./lib.js";

function RailRow({
  session,
  selected,
  now,
}: {
  session: SessionMetaView;
  selected: boolean;
  now: number;
}): React.ReactElement {
  const glyph = stateGlyph(session.derivedState);
  const active = isActiveState(session.derivedState);
  const meta = active
    ? formatElapsed(now - session.createdAt)
    : session.usage.costUsd > 0
      ? formatUsd(session.usage.costUsd)
      : "";

  // Every fixed-width cell pins flexShrink={0}: Ink boxes shrink by default
  // when a row is tight, which wraps their text mid-glyph ("docs" → "doc"/"s")
  // instead of truncating the one cell built to truncate — the title.
  return (
    <Box>
      <Box width={1} flexShrink={0}>
        <Text color={theme.cyan} bold>
          {selected ? "❯" : " "}
        </Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Text color={glyph.color} bold>
          {glyph.ch}
        </Text>
      </Box>
      <Box width={5} flexShrink={0}>
        <Text color={colorForSid(session.sid)} wrap="truncate">
          {shortSid(session.sid)}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0}>
        <Text
          color={selected ? "white" : undefined}
          bold={selected}
          dimColor={!selected}
          wrap="truncate"
        >
          {session.title || "untitled"}
        </Text>
      </Box>
      <Box width={5} flexShrink={0} justifyContent="flex-end">
        <Text dimColor wrap="truncate">
          {meta}
        </Text>
      </Box>
    </Box>
  );
}

export function SessionRail({
  sessions,
  selectedSid,
  width,
  now,
}: {
  sessions: readonly SessionMetaView[];
  selectedSid: string | null;
  width: number;
  now: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text dimColor>SESSIONS</Text>
      {sessions.map((s) => (
        <RailRow
          key={s.sid}
          session={s}
          selected={s.sid === selectedSid}
          now={now}
        />
      ))}
    </Box>
  );
}
