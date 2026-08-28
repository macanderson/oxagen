/**
 * roster-view.tsx — the [R]oster main pane: a dense one-row-per-session table
 * (spec §5).
 *
 * The same visual language as the agents screen's roster (glyph · id · title ·
 * activity · tokens · cost) but keyed to sessions and their derived lifecycle
 * state, including the `orphaned` state a crashed owner derives to. Column
 * widths are shared between the header and the rows so the two never drift.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatUsd } from "../../agent/model-router.js";
import { humanizeTokens } from "../../repl/components.js";
import { shortSid } from "../../sessions/ids.js";
import { isActiveState, type SessionMetaView } from "../../sessions/store.js";
import { colorForSid, formatElapsed, stateGlyph } from "./lib.js";

const W = {
  mark: 1,
  glyph: 2,
  sid: 6,
  title: 34,
  state: 11,
  turns: 6,
  tokens: 9,
  cost: 10,
} as const;

function RosterHeader(): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Box width={W.mark + W.glyph} />
      <Box width={W.sid}>
        <Text dimColor>ID</Text>
      </Box>
      <Box width={W.title}>
        <Text dimColor>TITLE</Text>
      </Box>
      <Box width={W.state}>
        <Text dimColor>STATE</Text>
      </Box>
      <Box width={W.turns}>
        <Text dimColor>TURNS</Text>
      </Box>
      <Box width={W.tokens} justifyContent="flex-end">
        <Text dimColor>TOKENS</Text>
      </Box>
      <Box width={W.cost} justifyContent="flex-end">
        <Text dimColor>COST</Text>
      </Box>
    </Box>
  );
}

function RosterRow({
  session,
  selected,
  now,
}: {
  session: SessionMetaView;
  selected: boolean;
  now: number;
}): React.ReactElement {
  const glyph = stateGlyph(session.derivedState);
  const tokens = session.usage.inputTokens + session.usage.outputTokens;
  const active = isActiveState(session.derivedState);
  const stateText = active
    ? formatElapsed(now - session.createdAt)
    : session.derivedState;

  return (
    <Box paddingX={1}>
      <Box width={W.mark}>
        <Text color={theme.cyan} bold>
          {selected ? "❯" : " "}
        </Text>
      </Box>
      <Box width={W.glyph}>
        <Text color={glyph.color} bold>
          {glyph.ch}
        </Text>
      </Box>
      <Box width={W.sid}>
        <Text color={colorForSid(session.sid)}>{shortSid(session.sid)}</Text>
      </Box>
      <Box width={W.title}>
        <Text
          color={selected ? "white" : undefined}
          bold={selected}
          wrap="truncate"
        >
          {session.title || "untitled"}
        </Text>
      </Box>
      <Box width={W.state}>
        <Text color={glyph.color}>{stateText}</Text>
      </Box>
      <Box width={W.turns}>
        <Text dimColor>{session.turns > 0 ? `${session.turns}` : "—"}</Text>
      </Box>
      <Box width={W.tokens} justifyContent="flex-end">
        <Text dimColor>{tokens > 0 ? humanizeTokens(tokens) : "—"}</Text>
      </Box>
      <Box width={W.cost} justifyContent="flex-end">
        <Text color={session.usage.costUsd > 0 ? theme.green : theme.dim}>
          {session.usage.costUsd > 0 ? formatUsd(session.usage.costUsd) : "—"}
        </Text>
      </Box>
    </Box>
  );
}

export function RosterView({
  sessions,
  selectedSid,
  now,
}: {
  sessions: readonly SessionMetaView[];
  selectedSid: string | null;
  now: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <RosterHeader />
      {sessions.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>No sessions in this fleet yet.</Text>
        </Box>
      ) : (
        sessions.map((s) => (
          <RosterRow
            key={s.sid}
            session={s}
            selected={s.sid === selectedSid}
            now={now}
          />
        ))
      )}
    </Box>
  );
}
