/**
 * survey-prompt.tsx — the interactive "clarification survey" overlay.
 *
 * Rendered in place of the prompt input while the coding agent is blocked on the
 * engine's `ask_user` tool (see `AskUserCallback` in @oxagen/agent-engine): the
 * agent has hit a genuinely ambiguous fork where guessing wrong is costly, so it
 * pauses and asks the human one structured question with 2-5 concrete options —
 * plus an always-present free-text escape hatch. Same take-over-the-keyboard
 * pattern as ScopeReview / ApprovalPrompt (scope-review.tsx / components.tsx):
 * the panel owns `useInput` outright and reports its outcome exactly once via
 * `onAnswer`.
 *
 * Two internal modes:
 *  - "select" (default) — arrow-key list of the options, with a final
 *    "Other (type your own)…" row that switches to free-text entry. Enter on an
 *    option answers with it; Enter on the "Other" row opens the input line.
 *  - "input" — a minimal single-line buffer for the user's own answer. Enter
 *    submits (when non-empty); Esc returns to the option list.
 *
 * Esc from the list DISMISSES the question: it answers with an explicit sentinel
 * (free-text) that tells the model nobody answered, so the agent proceeds on its
 * own best judgment rather than hanging — the engine tool never blocks forever.
 */
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { theme } from "../tui/theme.js";
import type { AskUserResponse } from "@oxagen/agent-engine";

export interface SurveyPromptProps {
  /** The single question the agent is asking. */
  question: string;
  /** The 2-5 concrete options the agent offered. */
  options: string[];
  /** Called exactly once when the user answers, picks free-text, or dismisses. */
  onAnswer: (answer: AskUserResponse) => void;
  /** Panel width in columns (parent passes Math.min(cols-2, 100)). Default 80. */
  width?: number;
}

/**
 * Answer sent when the user dismisses the question with Esc. Free-text by
 * construction — it is not one of the offered options — and phrased as an
 * instruction so the model degrades gracefully instead of re-asking or stalling.
 */
export const SURVEY_DISMISS_ANSWER =
  "(no answer — user dismissed the question; proceed with your best judgment and state the assumption)";

/** Label for the synthetic final row that opens free-text entry. */
const OTHER_LABEL = "Other (type your own)…";

export function SurveyPrompt({
  question,
  options,
  onAnswer,
  width = 80,
}: SurveyPromptProps): React.ReactElement {
  const [mode, setMode] = useState<"select" | "input">("select");
  const [selected, setSelected] = useState(0);
  const [buffer, setBuffer] = useState("");

  // The "Other" row sits one past the real options; total rows = options + 1.
  const otherIndex = options.length;
  const rowCount = options.length + 1;

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setSelected((i) => (i - 1 + rowCount) % rowCount);
        return;
      }
      if (key.downArrow) {
        setSelected((i) => (i + 1) % rowCount);
        return;
      }
      if (key.return) {
        if (selected === otherIndex) {
          setMode("input");
          return;
        }
        onAnswer({ answer: options[selected] ?? "", wasFreeText: false });
        return;
      }
      if (key.escape) {
        onAnswer({ answer: SURVEY_DISMISS_ANSWER, wasFreeText: true });
      }
    },
    { isActive: mode === "select" },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        setMode("select");
        return;
      }
      if (key.return) {
        const trimmed = buffer.trim();
        // Ignore an empty submit — keep waiting for the user to type something.
        if (trimmed.length === 0) return;
        onAnswer({ answer: trimmed, wasFreeText: true });
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      // Printable input only — control/meta chords never enter the buffer.
      if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
    },
    { isActive: mode === "input" },
  );

  const innerWidth = Math.max(width - 4, 20);

  if (mode === "input") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.violet}
        paddingX={1}
        width={width}
      >
        <Text color={theme.violet} bold>
          {"✎ Type your answer — Enter submits · Esc back to options"}
        </Text>
        <Box marginTop={1} width={innerWidth}>
          <Text color={theme.cyan}>{"❯ "}</Text>
          <Text>
            {buffer}
            <Text color={theme.cyan}>█</Text>
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.cyan}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={theme.cyan} bold>
          {`${theme.ring} `}
        </Text>
        <Text bold wrap="wrap">
          {question}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const isSel = i === selected;
          return (
            <Box key={i} width={innerWidth}>
              <Text color={isSel ? theme.cyan : undefined} bold={isSel}>
                {isSel ? "❯ " : "  "}
              </Text>
              <Text color={isSel ? theme.cyan : undefined} wrap="truncate-end">
                {opt}
              </Text>
            </Box>
          );
        })}
        <Box width={innerWidth}>
          <Text
            color={selected === otherIndex ? theme.violet : undefined}
            bold={selected === otherIndex}
          >
            {selected === otherIndex ? "❯ " : "  "}
          </Text>
          <Text
            color={selected === otherIndex ? theme.violet : undefined}
            dimColor={selected !== otherIndex}
          >
            {OTHER_LABEL}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ↵ choose · esc dismiss</Text>
      </Box>
    </Box>
  );
}
