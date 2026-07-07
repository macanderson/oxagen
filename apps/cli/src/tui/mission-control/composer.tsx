/**
 * composer.tsx — Mission Control's always-present input line (spec §5).
 *
 * Purely presentational: the root app owns the single keyboard handler and the
 * buffer/cursor state (so bare-letter view commands and free text never fight
 * over a keystroke — Ink delivers every key to every `useInput`), and hands this
 * component the current line to draw. It renders a target chip (the focused
 * session, or an `@sid` the line is addressing), the text with an in-line block
 * cursor, a placeholder when empty, and a dim one-line key legend beneath.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";

export function Composer({
  value,
  cursor,
  placeholder,
  targetLabel,
  targetColor,
  hint,
}: {
  value: string;
  cursor: number;
  placeholder: string;
  /** A chip shown left of the input: the focused session, or an `@sid` target. */
  targetLabel?: string;
  targetColor?: string;
  hint: string;
}): React.ReactElement {
  const left = value.slice(0, cursor);
  const under = value.slice(cursor, cursor + 1) || " ";
  const right = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.cyan} paddingX={1}>
        {targetLabel !== undefined ? (
          <Text color={targetColor ?? theme.violet} bold>
            {targetLabel}{" "}
          </Text>
        ) : null}
        <Text color={theme.cyan} bold>
          {theme.pointer}{" "}
        </Text>
        {value === "" ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          <Text>
            {left}
            <Text inverse>{under}</Text>
            {right}
          </Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
