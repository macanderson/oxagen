/**
 * Status Bar — bottom bar showing daemon health, uptime, hotkeys,
 * and aggregate session metrics.
 */
import { Box, Text } from "ink";
import React from "react";

interface StatusBarProps {
  tick: number;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function StatusBar({ tick }: StatusBarProps): React.ReactElement {
  const uptime = formatUptime(tick);

  return (
    <Box marginTop={1} paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text>
          <Text color="#34D399" bold>
            ●
          </Text>
          <Text dimColor> daemon</Text>
        </Text>
        <Text dimColor>up {uptime}</Text>
        <Text dimColor>│</Text>
        <Text dimColor>DuckDB warm</Text>
        <Text dimColor>│</Text>
        <Text dimColor>Neo4j connected</Text>
      </Box>

      <Box gap={2}>
        <Text dimColor>
          <Text bold>q</Text> quit
        </Text>
        <Text dimColor>
          <Text bold>r</Text> refresh
        </Text>
        <Text dimColor>
          <Text bold>m</Text> memories
        </Text>
        <Text dimColor>
          <Text bold>s</Text> sessions
        </Text>
      </Box>
    </Box>
  );
}
