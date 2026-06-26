/**
 * Interactive REPL — the default `oxagen` experience.
 *
 * Full-screen Ink TUI with:
 *   - Scrollable conversation history (user prompts + assistant responses)
 *   - Streaming response display with tool call annotations
 *   - Compact status bar showing engram memory stats + daemon health
 *   - Multi-line prompt input at the bottom
 *
 * Like Claude Code, but with Engram memory visible.
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useCallback, useRef } from "react";
import type { ModelMessage } from "ai";
import { theme } from "../tui/theme.js";
import { runAgent } from "../agent/loop.js";
import pkg from "../../package.json" with { type: "json" };

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  streaming?: boolean;
}

interface MemoryStats {
  recordsThisTurn: number;
  totalRecords: number;
  compileMs: number;
  cacheHitRate: number;
}

// ── Prompt Input ──────────────────────────────────────────────────────────────

function PromptInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (disabled) return;

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
      borderColor={disabled ? theme.dim : theme.cyan}
      paddingX={1}
    >
      <Text color={theme.cyan} bold>
        {disabled ? "⟳ " : "❯ "}
      </Text>
      <Text>
        {value}
        {!disabled && <Text color={theme.cyan}>█</Text>}
      </Text>
    </Box>
  );
}

// ── Message Display ───────────────────────────────────────────────────────────

function MessageView({ msg }: { msg: Message }): React.ReactElement {
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

// ── Status Bar ────────────────────────────────────────────────────────────────

function StatusLine({ stats }: { stats: MemoryStats }): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text dimColor>
          mem:<Text color="#34D399">{stats.totalRecords}</Text>
        </Text>
        <Text dimColor>
          turn:<Text color={theme.cyan}>{stats.recordsThisTurn}</Text>
        </Text>
        <Text dimColor>
          compile:
          <Text color={stats.compileMs < 20 ? "#34D399" : "#FBBF24"}>
            {stats.compileMs}ms
          </Text>
        </Text>
        <Text dimColor>
          cache:
          <Text color={stats.cacheHitRate > 0.6 ? "#34D399" : "#FBBF24"}>
            {Math.round(stats.cacheHitRate * 100)}%
          </Text>
        </Text>
      </Box>
      <Box gap={2}>
        <Text dimColor>/view dashboard</Text>
        <Text dimColor>/clear reset</Text>
        <Text dimColor>ctrl+c exit</Text>
      </Box>
    </Box>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  const text =
    typeof input === "object" ? JSON.stringify(input) : String(input);
  return text.length > 100 ? text.slice(0, 100) + "…" : text;
}

function ReplApp(): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stats, setStats] = useState<MemoryStats>({
    recordsThisTurn: 0,
    totalRecords: 0,
    compileMs: 0,
    cacheHitRate: 0,
  });

  // Source-of-truth message list (the state mirror), so streaming updates can be
  // computed synchronously without racing React's batched setState.
  const allRef = useRef<Message[]>([]);
  // Multi-turn conversation history fed back to the model each turn.
  const historyRef = useRef<ModelMessage[]>([]);

  const commit = useCallback((next: Message[]) => {
    allRef.current = next;
    setMessages(next);
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      // Handle slash commands
      if (text === "/clear") {
        allRef.current = [];
        historyRef.current = [];
        setMessages([]);
        return;
      }
      if (text === "/view") {
        // TODO: switch to agent-view
        return;
      }
      if (text === "/exit" || text === "/quit") {
        exit();
        return;
      }

      const userMsg: Message = {
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      const base = [...allRef.current, userMsg];
      commit(base);
      setIsStreaming(true);

      // This turn's streamed messages (tool annotations + assistant text).
      const turn: Message[] = [];
      let assistantOpen = false;
      const render = (): void => commit([...base, ...turn]);

      try {
        const result = await runAgent({
          prompt: text,
          history: historyRef.current,
          onToolCall: (name, input) => {
            turn.push({
              role: "tool",
              toolName: name,
              content: summarizeInput(input),
              timestamp: Date.now(),
            });
            assistantOpen = false;
            render();
          },
          onText: (delta) => {
            if (!assistantOpen) {
              turn.push({
                role: "assistant",
                content: "",
                streaming: true,
                timestamp: Date.now(),
              });
              assistantOpen = true;
            }
            const last = turn[turn.length - 1] as Message;
            turn[turn.length - 1] = { ...last, content: last.content + delta };
            render();
          },
        });

        if (assistantOpen) {
          const last = turn[turn.length - 1] as Message;
          turn[turn.length - 1] = { ...last, streaming: false };
        } else {
          turn.push({
            role: "assistant",
            content: result.text || "(done)",
            timestamp: Date.now(),
          });
        }
        render();
        historyRef.current = result.messages;
        setStats((prev) => ({
          ...prev,
          recordsThisTurn: result.steps,
          totalRecords: prev.totalRecords + result.steps,
        }));
      } catch (err) {
        turn.push({
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
        render();
      } finally {
        setIsStreaming(false);
      }
    },
    [exit, commit],
  );

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box paddingX={1} marginBottom={1}>
        <Text color={theme.cyan} bold>
          {theme.ring}{" "}
        </Text>
        <Text color={theme.violet} bold>
          oxagen
        </Text>
        <Text dimColor> · agentic coding · </Text>
        <Text dimColor>v{pkg.version}</Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {messages.length === 0 ? (
          <Box paddingX={1} flexDirection="column">
            <Text dimColor>Ready. Type a prompt to start coding.</Text>
            <Text dimColor>
              The Engram context engine compiles relevant memory each turn.
            </Text>
          </Box>
        ) : (
          messages.map((msg, i) => <MessageView key={i} msg={msg} />)
        )}
      </Box>

      {/* Status line */}
      <StatusLine stats={stats} />

      {/* Input */}
      <PromptInput onSubmit={handleSubmit} disabled={isStreaming} />
    </Box>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(): Promise<void> {
  const { render: renderInk } = await import("ink");
  const { waitUntilExit } = renderInk(<ReplApp />);
  await waitUntilExit();
}
