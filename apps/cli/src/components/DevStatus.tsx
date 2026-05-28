import { Box, Text } from "ink";
import React from "react";

// Stub view. The runner subagent's dev orchestrator will eventually
// pipe live container + app status through stdout; for now the CLI
// renders a static table so `oxagen dev` always returns something
// useful while wiring is in flight.
const rows: Array<{ name: string; port: number; state: string }> = [
  { name: "api", port: 4000, state: "stub" },
  { name: "mcp", port: 4100, state: "stub" },
  { name: "runner", port: 4200, state: "stub" },
  { name: "app", port: 3000, state: "stub" },
  { name: "website", port: 3100, state: "stub" },
];

export function DevStatus() {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Oxagen dev stack</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row) => (
          <Text key={row.name}>
            <Text color="cyan">{row.name.padEnd(10)}</Text>
            <Text color="gray">:{row.port}  </Text>
            <Text color="yellow">{row.state}</Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>
        Run `pnpm dev` from the repo root to bring the real stack online.
      </Text>
    </Box>
  );
}
