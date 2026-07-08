/**
 * Compile Panel — shows the last compile() result metrics including
 * retrieval engine breakdown, budget utilization, and cache hit rate.
 */
import { Box, Text } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";

interface CompileStats {
  totalMs: number;
  retrievalMs: number;
  packingMs: number;
  layoutMs: number;
  candidatesRetrieved: number;
  candidatesPacked: number;
  candidatesEvicted: number;
  candidatesCompressed: number;
  cacheHitRate: number;
  engines: Array<{ name: string; candidates: number; ms: number }>;
}

function progressBar(
  value: number,
  width = 16,
  color?: string,
): React.ReactElement {
  const filled = Math.round(value * width);
  const bar = "━".repeat(filled) + "╌".repeat(width - filled);
  return (
    <Text>
      <Text color={color ?? theme.cyan}>{bar.slice(0, filled)}</Text>
      <Text dimColor>{bar.slice(filled)}</Text>
    </Text>
  );
}

export function CompilePanel(): React.ReactElement {
  const [stats] = useState<CompileStats>({
    totalMs: 8,
    retrievalMs: 5,
    packingMs: 2,
    layoutMs: 1,
    candidatesRetrieved: 47,
    candidatesPacked: 12,
    candidatesEvicted: 28,
    candidatesCompressed: 7,
    cacheHitRate: 0.72,
    engines: [
      { name: "temporal", candidates: 15, ms: 2 },
      { name: "graph", candidates: 8, ms: 1 },
      { name: "vector", candidates: 14, ms: 3 },
      { name: "lexical", candidates: 10, ms: 1 },
    ],
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.violet}>
          ◈ COMPILE
        </Text>
        <Text dimColor> (last turn)</Text>
      </Box>

      {/* Timing */}
      <Box gap={1}>
        <Text dimColor>Total:</Text>
        <Text bold color={stats.totalMs < 20 ? "#34D399" : "#FBBF24"}>
          {stats.totalMs}ms
        </Text>
        <Text dimColor>
          │ R:{stats.retrievalMs}ms P:{stats.packingMs}ms L:{stats.layoutMs}ms
        </Text>
      </Box>

      {/* Cache hit rate */}
      <Box gap={1} marginTop={1}>
        <Text dimColor>Cache:</Text>
        {progressBar(
          stats.cacheHitRate,
          12,
          stats.cacheHitRate > 0.6 ? "#34D399" : "#FBBF24",
        )}
        <Text bold>{Math.round(stats.cacheHitRate * 100)}%</Text>
      </Box>

      {/* Candidate flow */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Candidates:</Text>
        <Box gap={1} paddingLeft={2}>
          <Text>Retrieved</Text>
          <Text bold color={theme.cyan}>
            {stats.candidatesRetrieved}
          </Text>
          <Text dimColor>→</Text>
          <Text>Packed</Text>
          <Text bold color="#34D399">
            {stats.candidatesPacked}
          </Text>
          <Text dimColor>│</Text>
          <Text dimColor>Compressed</Text>
          <Text>{stats.candidatesCompressed}</Text>
          <Text dimColor>│</Text>
          <Text dimColor>Evicted</Text>
          <Text color={theme.dim}>{stats.candidatesEvicted}</Text>
        </Box>
      </Box>

      {/* Engine breakdown */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Engines:</Text>
        {stats.engines.map((e) => (
          <Box key={e.name} paddingLeft={2} gap={1}>
            <Box width={10}>
              <Text>{e.name}</Text>
            </Box>
            <Text dimColor>{String(e.candidates).padStart(3)} hits</Text>
            <Text dimColor>({e.ms}ms)</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
