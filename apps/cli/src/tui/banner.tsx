import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { theme } from "./theme.js";

// Block-letter OXAGEN wordmark. Kept as a literal so it renders identically
// across terminals (no figlet dependency).
const WORDMARK: string[] = [
  " ██████  ██   ██  █████   ██████  ███████ ███    ██",
  "██    ██  ██ ██  ██   ██ ██       ██      ████   ██",
  "██    ██   ███   ███████ ██   ███ █████   ██ ██  ██",
  "██    ██  ██ ██  ██   ██ ██    ██ ██      ██  ██ ██",
  " ██████  ██   ██ ██   ██  ██████  ███████ ██   ████",
];

/** ms between each revealed row of the wordmark during the intro animation. */
const REVEAL_INTERVAL_MS = 70;

/**
 * The Oxagen ASCII wordmark, used as the REPL header. When `animate` is set the
 * rows reveal top-to-bottom on mount (a one-shot intro that plays the first time
 * the REPL renders); when unset it draws fully immediately. The row count is
 * fixed either way, so the layout never jumps — unrevealed rows render as blank
 * lines of the same width.
 */
export function Banner({
  version,
  animate = false,
}: {
  version: string;
  animate?: boolean;
}): React.ReactElement {
  const [revealed, setRevealed] = useState(animate ? 0 : WORDMARK.length);

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      setRevealed((n) => {
        if (n >= WORDMARK.length) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, REVEAL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [animate]);

  const width = WORDMARK[0]?.length ?? 0;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {WORDMARK.map((line, i) => (
        <Text key={i} color={theme.violet} bold>
          {i < revealed ? line : " ".repeat(width)}
        </Text>
      ))}
      <Text>
        <Text color={theme.cyan}>{theme.ring} </Text>
        <Text color={theme.violet} bold>
          Oxagen
        </Text>
        <Text dimColor>{`  ·  agentic coding CLI  ·  v${version}`}</Text>
      </Text>
    </Box>
  );
}
