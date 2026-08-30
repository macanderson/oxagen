/**
 * Sessions Panel — the audit table at the heart of `oxagen view`.
 *
 * One row per recorded agent run (interactive REPL or detached fleet worker),
 * newest first, read from the real ADR-023 session store. Every column is a
 * fact from disk: derived lifecycle state, short id, surface, title, model,
 * turn count, wall-clock duration, and recorded cost. Nothing is synthesized —
 * an empty store shows a "no runs yet" invitation.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import {
  colorForSid,
  formatDurationMs,
  stateGlyph,
} from "../mission-control/lib.js";
import { shortSid } from "../../sessions/ids.js";
import { formatUsd, type SessionRow } from "./data.js";

const OWNER_TAG: Record<"tui" | "worker", string> = {
  tui: "repl",
  worker: "fleet",
};

function RunLine({ row }: { row: SessionRow }): React.ReactElement {
  const g = stateGlyph(row.state);
  return (
    <Box gap={1}>
      <Text color={g.color}>{g.ch}</Text>
      <Box width={5}>
        <Text color={colorForSid(row.sid)}>{shortSid(row.sid)}</Text>
      </Box>
      <Box width={5}>
        <Text dimColor>{OWNER_TAG[row.owner]}</Text>
      </Box>
      <Box flexGrow={1} minWidth={8}>
        <Text wrap="truncate">
          {row.title.trim() === "" ? "(untitled)" : row.title}
        </Text>
      </Box>
      <Box width={12}>
        <Text dimColor wrap="truncate">
          {row.model ?? "—"}
        </Text>
      </Box>
      <Box width={4} justifyContent="flex-end">
        <Text dimColor>{row.turns}t</Text>
      </Box>
      <Box width={7} justifyContent="flex-end">
        <Text dimColor>{formatDurationMs(row.durationMs)}</Text>
      </Box>
      <Box width={8} justifyContent="flex-end">
        <Text color={row.usage.costUsd > 0 ? theme.green : theme.dim}>
          {formatUsd(row.usage.costUsd)}
        </Text>
      </Box>
    </Box>
  );
}

export function SessionsPanel({
  rows,
  limit = 10,
}: {
  rows: SessionRow[];
  limit?: number;
}): React.ReactElement {
  const shown = rows.slice(0, limit);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text bold color={theme.cyan}>
            ◈ AGENT RUNS
          </Text>
          <Text dimColor> · audit</Text>
        </Box>
        <Text dimColor>
          {rows.length} run{rows.length === 1 ? "" : "s"}
        </Text>
      </Box>

      {shown.length === 0 ? (
        <Box flexDirection="column">
          <Text dimColor>No agent runs recorded for this project yet.</Text>
          <Text dimColor>
            Start one:{" "}
            <Text color={theme.cyan}>oxagen &quot;fix the login bug&quot;</Text>{" "}
            · or · <Text color={theme.cyan}>oxagen agents &quot;…&quot;</Text>
          </Text>
        </Box>
      ) : (
        <>
          <Box gap={1}>
            <Text dimColor> </Text>
            <Box width={5}>
              <Text dimColor>id</Text>
            </Box>
            <Box width={5}>
              <Text dimColor>where</Text>
            </Box>
            <Box flexGrow={1} minWidth={8}>
              <Text dimColor>task</Text>
            </Box>
            <Box width={12}>
              <Text dimColor>model</Text>
            </Box>
            <Box width={4} justifyContent="flex-end">
              <Text dimColor>turns</Text>
            </Box>
            <Box width={7} justifyContent="flex-end">
              <Text dimColor>dur</Text>
            </Box>
            <Box width={8} justifyContent="flex-end">
              <Text dimColor>cost</Text>
            </Box>
          </Box>
          {shown.map((r) => (
            <RunLine key={r.sid} row={r} />
          ))}
          {rows.length > shown.length ? (
            <Box marginTop={1}>
              <Text dimColor>
                +{rows.length - shown.length} older · oxagen fleet list
              </Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}
