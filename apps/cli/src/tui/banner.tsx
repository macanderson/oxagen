import { Box, Text } from "ink";
import React from "react";
import { theme } from "./theme.js";

// Block-letter OXAGEN wordmark. Kept as a literal so it renders identically
// across terminals (no figlet dependency).
const WORDMARK: string[] = [
  "---------------------------------------------------",
  "                                                   ",
  " ██████  ██   ██  █████   ██████  ███████ ███    ██",
  "██    ██  ██ ██  ██   ██ ██       ██      ████   ██",
  "██    ██   ███   ███████ ██   ███ █████   ██ ██  ██",
  "██    ██  ██ ██  ██   ██ ██    ██ ██      ██  ██ ██",
  " ██████  ██   ██ ██   ██  ██████  ███████ ██   ████",
  "                                                   ",
  "---------------------------------------------------",
  "                                                   ",
];

export function Banner({ version }: { version: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {WORDMARK.map((line, i) => (
        <Text key={i} color={theme.violet} bold>
          {line}
        </Text>
      ))}
      <Text>
        <Text color={theme.cyan}>{theme.ring} </Text>
        <Text color={theme.violet} bold>
          Oxagen
        </Text>
        <Text dimColor>{`  ·  developer CLI  v${version}`}</Text>
      </Text>
    </Box>
  );
}
