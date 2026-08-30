/**
 * Code Graph Panel — real stats for the daemon's DuckDB code-graph store,
 * scoped to THIS repo, read strictly read-only.
 *
 * Four real states, never a fabricated one:
 *   absent  — the store file doesn't exist (never indexed on this machine)
 *   locked  — the file exists but a running daemon holds the write lock / it
 *             can't be opened read-only right now
 *   empty   — the store opened but has no rows for this project root
 *   ready   — real file / symbol / edge counts, embedding coverage, last index
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatAge, formatCount, type CodeGraphStatus } from "./data.js";

export function CodeGraphPanel({
  status,
  now,
}: {
  status: CodeGraphStatus;
  now: number;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.cyan}>
          ◈ CODE GRAPH
        </Text>
        <Text dimColor> · DuckDB</Text>
      </Box>
      <Body status={status} now={now} />
    </Box>
  );
}

function Body({
  status,
  now,
}: {
  status: CodeGraphStatus;
  now: number;
}): React.ReactElement {
  switch (status.state) {
    case "absent":
      return (
        <Box flexDirection="column">
          <Text color={theme.dim}>– not indexed</Text>
          <Text dimColor>Warm it: oxagen daemon start</Text>
        </Box>
      );
    case "locked":
      return (
        <Box flexDirection="column">
          <Text color={theme.amber}>◐ present, can&apos;t read now</Text>
          <Text dimColor>
            The daemon holds the write lock — try again shortly.
          </Text>
        </Box>
      );
    case "empty":
      return (
        <Box flexDirection="column">
          <Text color={theme.dim}>– store present, this repo not indexed</Text>
          <Text dimColor>Index it: oxagen daemon start</Text>
        </Box>
      );
    case "ready": {
      const coverage =
        status.files > 0
          ? Math.round((status.embeddedFiles / status.files) * 100)
          : 0;
      return (
        <Box flexDirection="column">
          <Box gap={2}>
            <Box gap={1}>
              <Text dimColor>files</Text>
              <Text bold color={theme.green}>
                {formatCount(status.files)}
              </Text>
            </Box>
            <Box gap={1}>
              <Text dimColor>symbols</Text>
              <Text bold>{formatCount(status.symbols)}</Text>
            </Box>
            <Box gap={1}>
              <Text dimColor>edges</Text>
              <Text bold>{formatCount(status.edges)}</Text>
            </Box>
          </Box>
          <Box gap={2} marginTop={1}>
            <Box gap={1}>
              <Text dimColor>embedded</Text>
              <Text color={coverage > 0 ? theme.green : theme.dim}>
                {status.embeddedFiles}/{status.files} ({coverage}%)
              </Text>
            </Box>
          </Box>
          {status.lastIndexedAt !== null ? (
            <Box marginTop={1}>
              <Text dimColor>
                indexed {formatAge(status.lastIndexedAt, now)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }
  }
}
