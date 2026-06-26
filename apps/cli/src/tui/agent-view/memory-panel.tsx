/**
 * Memory Panel — shows recent memory writes with kind badges,
 * salience indicators, and content previews.
 */
import { Box, Text } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";

interface MemoryEntry {
  id: string;
  kind: "episodic" | "semantic" | "procedural" | "entity" | "edge";
  summary: string;
  salience: number;
  age: string;
}

const KIND_SYMBOLS: Record<string, string> = {
  episodic: "⚡",
  semantic: "📘",
  procedural: "⚙️",
  entity: "◆",
  edge: "─→",
};

const KIND_COLORS: Record<string, string> = {
  episodic: "#60A5FA",
  semantic: "#34D399",
  procedural: "#FBBF24",
  entity: "#A78BFA",
  edge: "#F472B6",
};

function salienceBar(value: number, width = 8): string {
  const filled = Math.round(value * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function MemoryPanel(): React.ReactElement {
  // In production, this would subscribe to the daemon's event stream.
  // For now, show a static example that demonstrates the layout.
  const [memories] = useState<MemoryEntry[]>([
    {
      id: "a1b2c3d4",
      kind: "episodic",
      summary: "tool_call: grep (success)",
      salience: 0.65,
      age: "2s",
    },
    {
      id: "e5f6g7h8",
      kind: "semantic",
      summary: "API uses OAuth2 for authentication",
      salience: 0.82,
      age: "5m",
    },
    {
      id: "i9j0k1l2",
      kind: "procedural",
      summary: "Always validate input schemas",
      salience: 1.0,
      age: "2h",
    },
    {
      id: "m3n4o5p6",
      kind: "episodic",
      summary: "decision: use knapsack packer",
      salience: 0.55,
      age: "12s",
    },
    {
      id: "q7r8s9t0",
      kind: "episodic",
      summary: "tool_call: read_file (success)",
      salience: 0.45,
      age: "30s",
    },
    {
      id: "u1v2w3x4",
      kind: "entity",
      summary: "function: buildTaskFrame",
      salience: 0.4,
      age: "1h",
    },
  ]);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.cyan}>
          ◈ MEMORIES
        </Text>
        <Text dimColor> ({memories.length} recent)</Text>
      </Box>

      {memories.map((mem) => (
        <Box key={mem.id} gap={1}>
          <Text color={KIND_COLORS[mem.kind]}>
            {KIND_SYMBOLS[mem.kind] ?? "·"}
          </Text>
          <Box width={10}>
            <Text dimColor>{mem.kind.slice(0, 8).padEnd(8)}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="truncate">{mem.summary}</Text>
          </Box>
          <Box width={10}>
            <Text
              color={
                mem.salience >= 0.7
                  ? "#34D399"
                  : mem.salience >= 0.4
                    ? "#FBBF24"
                    : theme.dim
              }
            >
              {salienceBar(mem.salience)}
            </Text>
          </Box>
          <Box width={5}>
            <Text dimColor>{mem.age.padStart(4)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
