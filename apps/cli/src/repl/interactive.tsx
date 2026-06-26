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
import React, { useState, useCallback } from "react";
import { theme } from "../tui/theme.js";
import { getApiUrl, getToken } from "../lib/config.js";
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

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      // Handle slash commands
      if (text === "/clear") {
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

      // Add user message
      const userMsg: Message = {
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      try {
        const response = await sendPrompt(text);
        const assistantMsg: Message = {
          role: "assistant",
          content: response.content,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);

        // Update stats from response metadata
        if (response.meta) {
          const meta = response.meta;
          setStats((prev) => ({
            ...prev,
            recordsThisTurn: meta.memoryWrites ?? 0,
            totalRecords: prev.totalRecords + (meta.memoryWrites ?? 0),
            compileMs: meta.compileMs ?? prev.compileMs,
            cacheHitRate: meta.cacheHitRate ?? prev.cacheHitRate,
          }));
        }
      } catch (err) {
        const errorMsg: Message = {
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setIsStreaming(false);
      }
    },
    [exit],
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

// ── API ───────────────────────────────────────────────────────────────────────

interface PromptResponse {
  content: string;
  meta?: {
    memoryWrites?: number;
    compileMs?: number;
    cacheHitRate?: number;
  };
}

async function sendPrompt(text: string): Promise<PromptResponse> {
  const token = getToken();
  const apiUrl = getApiUrl();

  if (!token) {
    return {
      content:
        "No API token configured. Run `oxagen config token <your-token>` to set one,\n" +
        "or set OXAGEN_API_TOKEN environment variable.",
    };
  }

  const response = await fetch(`${apiUrl}/chat/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: text }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as PromptResponse;
  return data;
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(): Promise<void> {
  const { render: renderInk } = await import("ink");
  const { waitUntilExit } = renderInk(<ReplApp />);
  await waitUntilExit();
}
