/**
 * prompts-panel.tsx — the saved-prompts picker.
 *
 * A takeover panel that lists the user's saved prompts and drops the chosen
 * one's body into the composer. ↑/↓ move the selection (wrapping), Enter inserts
 * the highlighted prompt's body via `onInsert` and closes, `v` toggles a
 * scrollable preview of the body, and `n` starts a new prompt via `onCreateNew`
 * (when provided). Typing any other printable character narrows the list by a
 * case-insensitive match across name + description; backspace edits the query.
 *
 * Reserved keys: because `v`/`n` are single-key commands (matching the panel
 * idiom — cf. files-panel's `r`), they are NOT captured by the type-to-filter
 * query; a query cannot begin with those letters. Prompt names/descriptions are
 * short, so this is an accepted trade rather than a `/`-gated search mode.
 */
import { Box, Text, useInput } from "ink";
import React, { useMemo, useState } from "react";
import { theme } from "../tui/theme.js";
import { visibleWindow } from "./slash-menu.js";

/** Max prompt rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_PROMPTS = 10;

/** Max preview body rows shown at once before the preview scrolls. */
export const MAX_PREVIEW_ROWS = 14;

/** One saved prompt the picker can insert. */
export interface SavedPrompt {
  name: string;
  description: string;
  body: string;
}

/** Case-insensitive filter across a prompt's name and description. */
export function filterPrompts(
  prompts: readonly SavedPrompt[],
  query: string,
): SavedPrompt[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...prompts];
  return prompts.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q),
  );
}

export interface PromptsPanelProps {
  /** False while another surface owns the keyboard; the panel ignores keys. */
  active?: boolean;
  onClose: () => void;
  prompts: readonly SavedPrompt[];
  /** Insert the chosen prompt's body into the composer. */
  onInsert: (body: string) => void;
  /** Start authoring a new prompt (bound to `n`); the hint hides when absent. */
  onCreateNew?: () => void;
  width?: number;
}

export function PromptsPanel({
  active = true,
  onClose,
  prompts,
  onInsert,
  onCreateNew,
  width = 84,
}: PromptsPanelProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);

  const filtered = useMemo(
    () => filterPrompts(prompts, query),
    [prompts, query],
  );
  const clampedSelected = Math.min(selected, Math.max(0, filtered.length - 1));
  const current = filtered[clampedSelected];

  const bodyLines = useMemo(
    () => (current ? current.body.split("\n") : []),
    [current],
  );
  const maxTop = Math.max(0, bodyLines.length - MAX_PREVIEW_ROWS);
  const clampedTop = Math.min(scrollTop, maxTop);

  useInput(
    (input, key) => {
      // Preview mode: arrows scroll the body; v/Esc/← returns to the list.
      if (previewing) {
        if (key.escape || input === "v" || key.leftArrow) {
          setPreviewing(false);
          return;
        }
        if (key.upArrow) {
          setScrollTop((t) => Math.max(0, t - 1));
          return;
        }
        if (key.downArrow) {
          setScrollTop((t) => Math.min(maxTop, t + 1));
          return;
        }
        if (key.pageUp) {
          setScrollTop((t) => Math.max(0, t - MAX_PREVIEW_ROWS));
          return;
        }
        if (key.pageDown) {
          setScrollTop((t) => Math.min(maxTop, t + MAX_PREVIEW_ROWS));
        }
        return;
      }

      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        if (filtered.length === 0) return;
        setSelected((clampedSelected - 1 + filtered.length) % filtered.length);
        return;
      }
      if (key.downArrow) {
        if (filtered.length === 0) return;
        setSelected((clampedSelected + 1) % filtered.length);
        return;
      }
      if (key.return) {
        if (current) {
          onInsert(current.body);
          onClose();
        }
        return;
      }
      if (input === "v") {
        if (current) {
          setScrollTop(0);
          setPreviewing(true);
        }
        return;
      }
      if (input === "n") {
        onCreateNew?.();
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      // Any other printable character narrows the list.
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
      }
    },
    { isActive: active },
  );

  const innerWidth = Math.max(width - 4, 20);

  // Preview view.
  if (previewing && current) {
    const visible = bodyLines.slice(clampedTop, clampedTop + MAX_PREVIEW_ROWS);
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.violet}
        paddingX={1}
        width={width}
      >
        <Box gap={1}>
          <Text color={theme.violet} bold wrap="truncate-end">
            {current.name}
          </Text>
          <Text dimColor>preview</Text>
        </Box>
        <Box flexDirection="column" marginTop={1} width={innerWidth}>
          {visible.map((line, i) => (
            <Text key={clampedTop + i} wrap="truncate-end">
              {line === "" ? " " : line}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {bodyLines.length > MAX_PREVIEW_ROWS
              ? `line ${clampedTop + 1}–${Math.min(bodyLines.length, clampedTop + MAX_PREVIEW_ROWS)} of ${bodyLines.length} · `
              : ""}
            ↑↓ scroll · v/esc back
          </Text>
        </Box>
      </Box>
    );
  }

  const { start, end } = visibleWindow(
    filtered.length,
    clampedSelected,
    MAX_VISIBLE_PROMPTS,
  );
  const visible = filtered.slice(start, end);
  const nameWidth = Math.min(
    24,
    Math.max(8, ...filtered.map((p) => p.name.length)),
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={theme.violet} bold>
          {"Saved Prompts "}
        </Text>
        <Text dimColor>
          · {filtered.length}
          {query
            ? ` match "${query}"`
            : ` prompt${prompts.length === 1 ? "" : "s"}`}
        </Text>
      </Box>

      {prompts.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No saved prompts yet
            {onCreateNew ? " — press n to create one." : "."}
          </Text>
        </Box>
      ) : filtered.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No prompts match "{query}".</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((prompt, i) => {
            const idx = start + i;
            const isSelected = idx === clampedSelected;
            return (
              <Box key={prompt.name} width={innerWidth}>
                <Text
                  color={isSelected ? theme.violet : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={nameWidth} flexShrink={0}>
                  <Text
                    color={isSelected ? theme.violet : undefined}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    {prompt.name}
                  </Text>
                </Box>
                <Box marginLeft={1} flexGrow={1}>
                  <Text dimColor wrap="truncate-end">
                    {prompt.description}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {filtered.length > MAX_VISIBLE_PROMPTS
            ? `${clampedSelected + 1}/${filtered.length} · `
            : ""}
          ↑↓ navigate · ↵ insert · v preview
          {onCreateNew ? " · n new" : ""} · type to filter · esc close
        </Text>
      </Box>
    </Box>
  );
}
