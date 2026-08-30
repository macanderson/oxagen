/**
 * Status Bar — the bottom band of `oxagen view`. Every indicator is a REAL
 * probe result: the daemon is shown up only when its socket actually answered,
 * the code graph reflects its true store state, and auth shows the effective
 * mode the run paths would use. The only advertised key is quit, because quit
 * is the only key the view binds.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatClock } from "../mission-control/lib.js";
import type { AuthStatus, CodeGraphStatus, DaemonStatus } from "./data.js";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function DaemonIndicator({
  daemon,
}: {
  daemon: DaemonStatus;
}): React.ReactElement {
  if (!daemon.running) {
    return (
      <Text>
        <Text color={theme.dim}>○</Text>
        <Text dimColor> daemon off</Text>
      </Text>
    );
  }
  const up =
    daemon.uptimeSeconds !== undefined
      ? ` up ${formatUptime(daemon.uptimeSeconds)}`
      : "";
  return (
    <Text>
      <Text color={theme.green} bold>
        ●
      </Text>
      <Text dimColor> daemon{up}</Text>
    </Text>
  );
}

function graphLabel(status: CodeGraphStatus): {
  glyph: string;
  color: string;
  text: string;
} {
  switch (status.state) {
    case "ready":
      return { glyph: "●", color: theme.green, text: "graph ready" };
    case "locked":
      return { glyph: "◐", color: theme.amber, text: "graph locked" };
    case "empty":
      return { glyph: "○", color: theme.dim, text: "graph empty" };
    case "absent":
      return { glyph: "○", color: theme.dim, text: "graph absent" };
  }
}

export function StatusBar({
  auth,
  daemon,
  codeGraph,
  generatedAt,
}: {
  auth: AuthStatus;
  daemon: DaemonStatus;
  codeGraph: CodeGraphStatus;
  generatedAt: number;
}): React.ReactElement {
  const g = graphLabel(codeGraph);
  return (
    <Box marginTop={1} paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <DaemonIndicator daemon={daemon} />
        <Text dimColor>│</Text>
        <Text>
          <Text color={g.color}>{g.glyph}</Text>
          <Text dimColor> {g.text}</Text>
        </Text>
        <Text dimColor>│</Text>
        <Text>
          <Text color={auth.ok ? theme.green : theme.amber}>
            {auth.ok ? "✓" : "✗"}
          </Text>
          <Text dimColor> {auth.label}</Text>
        </Text>
      </Box>

      <Box gap={2}>
        <Text dimColor>updated {formatClock(generatedAt)}</Text>
        <Text dimColor>
          <Text bold>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}
