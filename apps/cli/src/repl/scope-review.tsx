/**
 * scope-review.tsx — the pre-execution "confirm scope & cost" overlay.
 *
 * Surfaced after ROUTE and before EXECUTE (see `ScopeReviewInfo` in
 * @oxagen/agent-engine's trace/types.ts) so the human sees exactly what the
 * agent is about to run — the original prompt, the enhanced prompt the
 * executor will actually receive, the routed model, and the estimated cost —
 * before any tool call fires. Same take-over-the-keyboard pattern as
 * ApprovalPrompt/ConfigPanel (components.tsx / config-panel.tsx): the panel
 * owns `useInput` outright and reports its outcome exactly once via
 * `onDecision`.
 *
 * Two internal modes:
 *  - "review" (default) — read-only summary; Enter/y runs, e edits, Esc/n
 *    cancels.
 *  - "edit" — a minimal single-buffer textarea preloaded with the enhanced
 *    prompt. Intentionally no cursor movement or history (insert + backspace
 *    + newline + submit only) — this is a quick edit surface, not a full
 *    editor, and adding one would be scope creep for a confirm-before-run gate.
 */
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { theme } from "../tui/theme.js";
import { formatUsd } from "../agent/rate-card.js";
import type {
  ScopeReviewInfo,
  ScopeReviewDecision,
} from "@oxagen/agent-engine";

export interface ScopeReviewProps {
  info: ScopeReviewInfo;
  /** Called exactly once when the user decides. */
  onDecision: (d: ScopeReviewDecision) => void;
  /** Panel width in columns (parent passes Math.min(cols-2, 100)). */
  width: number;
  /** When true, show the full enhanced prompt (Ctrl+O expand). Default false → truncated preview. */
  expanded?: boolean;
}

const AFFORDANCE = "… (Ctrl+O for full)";

/** Split on lines, cap to `max` lines, and note truncation — shared by the
 *  original-prompt preview (fixed 3 lines) and the enhanced-prompt preview
 *  (6 lines, or unlimited when `expanded`). */
function previewLines(
  text: string,
  max: number,
): { lines: string[]; truncated: boolean } {
  const all = text.split(/\r?\n/);
  if (all.length <= max) return { lines: all, truncated: false };
  return { lines: all.slice(0, max), truncated: true };
}

function TruncatablePreview({
  text,
  maxLines,
  width,
}: {
  text: string;
  maxLines: number;
  width: number;
}): React.ReactElement {
  const { lines, truncated } = previewLines(text, maxLines);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line.length > width ? line.slice(0, width) : line}
        </Text>
      ))}
      {truncated ? <Text dimColor>{AFFORDANCE}</Text> : null}
    </Box>
  );
}

export function ScopeReview({
  info,
  onDecision,
  width,
  expanded = false,
}: ScopeReviewProps): React.ReactElement {
  const [mode, setMode] = useState<"review" | "edit">("review");
  const [buffer, setBuffer] = useState(info.enhancedPrompt);

  useInput(
    (input, key) => {
      if (key.return) {
        onDecision({ proceed: true });
        return;
      }
      if (input === "y") {
        onDecision({ proceed: true });
        return;
      }
      if (input === "e") {
        setMode("edit");
        return;
      }
      if (key.escape || input === "n") {
        onDecision({ proceed: false });
      }
    },
    { isActive: mode === "review" },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        setMode("review");
        return;
      }
      if (key.return) {
        const trimmed = buffer.trim();
        onDecision({
          proceed: true,
          prompt: trimmed.length > 0 ? trimmed : info.enhancedPrompt,
        });
        return;
      }
      // Ctrl-J inserts a literal newline — same convention as the main
      // PromptInput (components.tsx), where a bare linefeed byte is the one
      // portable "explicit newline" signal across terminals.
      if (key.ctrl && input === "j") {
        setBuffer((b) => b + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setBuffer((b) => b + input);
      }
    },
    { isActive: mode === "edit" },
  );

  const innerWidth = Math.max(width - 4, 20);

  if (mode === "edit") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.violet}
        paddingX={1}
        width={width}
      >
        <Text color={theme.violet} bold>
          {"✎ Edit the prompt — Enter runs · Ctrl+J newline · Esc cancels edit"}
        </Text>
        <Box marginTop={1}>
          <Text wrap="wrap">{buffer}</Text>
        </Box>
      </Box>
    );
  }

  const modelName = info.model.split("/").pop();
  const hasContext = info.context.trim().length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.cyan}
      paddingX={1}
      width={width}
    >
      <Text color={theme.cyan} bold>
        {`${theme.ring} Review scope & cost`}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>You asked:</Text>
        <TruncatablePreview
          text={info.originalPrompt}
          maxLines={3}
          width={innerWidth}
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Enhanced prompt (what the agent will run):</Text>
        <TruncatablePreview
          text={info.enhancedPrompt}
          maxLines={expanded ? Number.POSITIVE_INFINITY : 6}
          width={innerWidth}
        />
        {!hasContext ? (
          <Text dimColor>no extra context was injected</Text>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.violet} bold>
          {modelName}
        </Text>
        <Text dimColor> · {info.tier} · </Text>
        <Text dimColor>est. </Text>
        <Text color={theme.amber}>{formatUsd(info.estimatedCostUsd)}</Text>
        <Text dimColor>
          {" "}
          · ~{info.estimatedInputTokens}→{info.estimatedOutputTokens} tok
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter run · e edit · Esc cancel</Text>
      </Box>
    </Box>
  );
}
