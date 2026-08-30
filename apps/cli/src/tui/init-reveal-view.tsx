/**
 * Ink renderer for the OXAGEN reveal payoff: draws tui/init-reveal.ts's
 * column-by-column frames on a timer, then holds on the completed wordmark
 * for a beat before calling `onDone` — the signal init-animation.tsx uses to
 * unmount and hand the terminal back for whatever runs next (the summary
 * print, and the workspace linker's prompts if any).
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import {
  revealFrame,
  isRevealComplete,
  WORDMARK_WIDTH,
} from "./init-reveal.js";

const REVEAL_TICK_MS = 45;
const REVEAL_COLS_PER_TICK = 2;
const HOLD_MS = 700;

export interface InitRevealViewProps {
  /** Called once the wordmark has fully drawn and held for a beat. */
  onDone: () => void;
  /** Test seams — real timers with tiny durations instead of mocking. */
  tickMs?: number;
  holdMs?: number;
}

export function InitRevealView({
  onDone,
  tickMs = REVEAL_TICK_MS,
  holdMs = HOLD_MS,
}: InitRevealViewProps): React.ReactElement {
  const [cols, setCols] = useState(0);
  const complete = isRevealComplete(cols);

  useEffect(() => {
    if (complete) return;
    const id = setInterval(() => {
      setCols((c) => Math.min(WORDMARK_WIDTH, c + REVEAL_COLS_PER_TICK));
    }, tickMs);
    return () => clearInterval(id);
  }, [complete, tickMs]);

  useEffect(() => {
    if (!complete) return;
    const t = setTimeout(onDone, holdMs);
    return () => clearTimeout(t);
  }, [complete, holdMs, onDone]);

  const lines = revealFrame(cols);

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {lines.map((line, i) => (
        <Text key={i} color={theme.violet} bold>
          {line}
        </Text>
      ))}
      <Text color={complete ? theme.green : theme.dim}>
        {"  "}
        {complete ? `${theme.ring} ready` : " "}
      </Text>
    </Box>
  );
}
