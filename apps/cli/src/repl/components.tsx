/**
 * Presentational components for the REPL.
 *
 * Kept deliberately free of heavy imports (no agent loop, no context engine) so
 * they render instantly and are unit-testable in isolation with
 * ink-testing-library.
 */
import { Box, Text, useInput } from "ink";
import React, { useState, useEffect } from "react";
import { theme } from "../tui/theme.js";

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  streaming?: boolean;
}

export const HELP = [
  "Slash commands:",
  "  /help          show this help",
  "  /model [slug]  show or set the gateway model",
  "  /clear         reset the conversation",
  "  /exit, /quit   quit",
  "Esc / Ctrl-C     cancel the current turn (Ctrl-C quits when idle)",
].join("\n");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Compact token count: 1234 → "1.2k", 980 → "980", 23000 → "23k". */
export function humanizeTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
}

// ── Prompt Input ──────────────────────────────────────────────────────────────

export function PromptInput({
  onSubmit,
  busy,
}: {
  onSubmit: (text: string) => void;
  /** A turn is in flight. The input stays live — submissions queue (Claude
   *  Code-style) instead of being blocked — but the glyph shows the busy state. */
  busy: boolean;
}): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return && !key.shift) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={busy ? "#FBBF24" : theme.cyan}
      paddingX={1}
    >
      <Text color={busy ? "#FBBF24" : theme.cyan} bold>
        {busy ? "⧗ " : "❯ "}
      </Text>
      <Text>
        {value}
        <Text color={theme.cyan}>█</Text>
      </Text>
    </Box>
  );
}

// ── Message Display ───────────────────────────────────────────────────────────

export function MessageView({ msg }: { msg: Message }): React.ReactElement {
  if (msg.role === "user") {
    return (
      <Box paddingX={1} marginY={0}>
        <Text color={theme.cyan} bold>
          {"❯ "}
        </Text>
        <Text bold>{msg.content}</Text>
      </Box>
    );
  }

  if (msg.role === "tool") {
    return (
      <Box paddingX={1} marginY={0}>
        <Text color="#FBBF24">{"  ⚡ "}</Text>
        <Text dimColor>{msg.toolName ?? "tool"}</Text>
        <Text dimColor>{" → "}</Text>
        <Text wrap="truncate">{msg.content}</Text>
      </Box>
    );
  }

  // assistant
  return (
    <Box paddingX={1} marginY={0} flexDirection="column">
      <Text>
        {msg.content}
        {msg.streaming && <Text color={theme.cyan}>▊</Text>}
      </Text>
    </Box>
  );
}

// ── Thinking Indicator ────────────────────────────────────────────────────────

/**
 * Animated "the agent is working" indicator: a braille spinner, elapsed seconds,
 * and a live estimate of output tokens for the in-flight turn. It runs its own
 * ~100ms timer so it animates independently of streaming updates.
 */
export function ThinkingIndicator({
  startedAt,
  getTokens,
}: {
  startedAt: number;
  getTokens: () => number;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const tokens = getTokens();
  return (
    <Box paddingX={1}>
      <Text color="#FBBF24" bold>
        {SPINNER[frame % SPINNER.length]}{" "}
      </Text>
      <Text color="#FBBF24">Thinking… </Text>
      <Text dimColor>
        {elapsed}s{tokens > 0 ? ` · ~${humanizeTokens(tokens)} tok` : ""} · esc to
        cancel
      </Text>
    </Box>
  );
}

// ── Status Bar ────────────────────────────────────────────────────────────────

export function StatusLine({
  model,
  readOnly,
  turns,
  inputTokens,
  outputTokens,
}: {
  model: string;
  readOnly: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}): React.ReactElement {
  const total = inputTokens + outputTokens;
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text dimColor>
          model:<Text color={theme.cyan}>{model.split("/").pop()}</Text>
        </Text>
        <Text dimColor>
          turns:<Text color="#34D399">{turns}</Text>
        </Text>
        <Text dimColor>
          tokens:<Text color={theme.cyan}>↑{humanizeTokens(inputTokens)}</Text>{" "}
          <Text color="#34D399">↓{humanizeTokens(outputTokens)}</Text>
          {total > 0 ? <Text dimColor> (Σ{humanizeTokens(total)})</Text> : null}
        </Text>
        {readOnly && <Text color="#FBBF24">read-only</Text>}
      </Box>
      <Box gap={2}>
        <Text dimColor>/help</Text>
        <Text dimColor>/clear</Text>
        <Text dimColor>esc·ctrl+c</Text>
      </Box>
    </Box>
  );
}
