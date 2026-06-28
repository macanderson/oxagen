/**
 * Dispatch Input — the live prompt line for adding a new agent to the fleet.
 *
 * A controlled, single-line text field using the same input model as the REPL's
 * {@link PromptInput}: typed characters edit the buffer, Enter dispatches the
 * trimmed text via `onDispatch` and clears it, and an empty submit is a no-op. It
 * owns only its own buffer — Ctrl-C and other global chords are handled one level
 * up in {@link FleetApp}, which is why control/meta input is ignored here.
 */
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";

export function DispatchInput({
  onDispatch,
}: {
  onDispatch: (text: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      const text = value.trim();
      if (text) {
        onDispatch(text);
        setValue("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    // Ignore control/meta chords — those belong to the app-level key handler.
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box borderStyle="round" borderColor={theme.cyan} paddingX={1}>
      <Text color={theme.cyan} bold>
        {theme.pointer}{" "}
      </Text>
      <Text>
        {value}
        <Text color={theme.cyan}>█</Text>
      </Text>
      {value ? null : (
        <Text dimColor> submit a prompt using enter to dispatch an agent</Text>
      )}
    </Box>
  );
}
