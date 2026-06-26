/**
 * Activity Feed — real-time scrolling feed of agent actions,
 * tool calls, decisions, and memory operations.
 */
import { Box, Text } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";

interface ActivityEntry {
  timestamp: string;
  type: "tool" | "decision" | "memory" | "compile" | "error" | "graph";
  message: string;
  detail?: string;
}

const TYPE_CONFIG: Record<string, { symbol: string; color: string }> = {
  tool: { symbol: "⚡", color: "#60A5FA" },
  decision: { symbol: "◆", color: "#A78BFA" },
  memory: { symbol: "💾", color: "#34D399" },
  compile: { symbol: "⟐", color: theme.cyan },
  error: { symbol: "✗", color: "#EF4444" },
  graph: { symbol: "◇", color: "#F472B6" },
};

export function ActivityFeed(): React.ReactElement {
  const [entries] = useState<ActivityEntry[]>([
    { timestamp: "15:42:08", type: "compile", message: "Context compiled", detail: "8ms · 72% cache · 12 records" },
    { timestamp: "15:42:09", type: "tool", message: "grep_search", detail: "'handleLogin' in src/**/*.ts → 3 matches" },
    { timestamp: "15:42:10", type: "memory", message: "Episodic write", detail: "tool_call: grep (success) · sal:0.45" },
    { timestamp: "15:42:11", type: "tool", message: "read_file", detail: "src/auth/session.ts (142 lines)" },
    { timestamp: "15:42:11", type: "memory", message: "Episodic write", detail: "tool_call: read (success) · sal:0.50" },
    { timestamp: "15:42:12", type: "graph", message: "Neo4j sync", detail: ":REMEMBERS → file:auth/session.ts" },
    { timestamp: "15:42:13", type: "decision", message: "Route to fix", detail: "Auth token validation missing null check" },
    { timestamp: "15:42:14", type: "tool", message: "str_replace", detail: "src/auth/session.ts:47 · added null guard" },
    { timestamp: "15:42:14", type: "memory", message: "Semantic assert", detail: "\"Session validation requires null check\" · conf:0.85" },
  ]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="#FBBF24">◈ ACTIVITY</Text>
        <Text dimColor>  (live feed)</Text>
      </Box>

      {entries.map((entry, i) => {
        const cfg = TYPE_CONFIG[entry.type] ?? TYPE_CONFIG["tool"]!;
        return (
          <Box key={i} gap={1}>
            <Text dimColor>{entry.timestamp}</Text>
            <Text color={cfg.color}>{cfg.symbol}</Text>
            <Text bold>{entry.message}</Text>
            {entry.detail && <Text dimColor wrap="truncate">{entry.detail}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
