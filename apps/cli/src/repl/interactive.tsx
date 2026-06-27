/**
 * Interactive REPL — the default `oxagen` experience.
 *
 * Full-screen Ink TUI with:
 *   - Scrollable conversation history (user prompts + assistant responses)
 *   - Streaming response display with tool call annotations
 *   - Multi-turn history, project rules, and Oxagen context-engine memory
 *   - Slash commands (/help, /model, /clear, /exit) and Ctrl-C to cancel a turn
 *
 * Like Claude Code, but backed by the Oxagen context engine.
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModelMessage } from "ai";
import { theme } from "../tui/theme.js";
import { runAgent } from "../agent/loop.js";
import { resolveModelId } from "../agent/model.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory, type SessionMemory } from "../agent/memory.js";
import pkg from "../../package.json" with { type: "json" };

export interface ReplOptions {
  model?: string;
  readOnly?: boolean;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  streaming?: boolean;
}

const HELP = [
  "Slash commands:",
  "  /help          show this help",
  "  /model [slug]  show or set the gateway model",
  "  /clear         reset the conversation",
  "  /exit, /quit   quit",
  "Ctrl-C           cancel the current turn (or quit when idle)",
].join("\n");

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

function StatusLine({
  model,
  readOnly,
  turns,
}: {
  model: string;
  readOnly: boolean;
  turns: number;
}): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text dimColor>
          model:<Text color={theme.cyan}>{model.split("/").pop()}</Text>
        </Text>
        <Text dimColor>
          turns:<Text color="#34D399">{turns}</Text>
        </Text>
        {readOnly && <Text color="#FBBF24">read-only</Text>}
      </Box>
      <Box gap={2}>
        <Text dimColor>/help</Text>
        <Text dimColor>/clear</Text>
        <Text dimColor>ctrl+c</Text>
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

function ReplApp({ options }: { options: ReplOptions }): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState<string>(resolveModelId(options.model));
  const [turns, setTurns] = useState(0);

  const cwd = process.cwd();
  // Project rules (CLAUDE.md/AGENTS.md) loaded once for the session.
  const projectContextRef = useRef(loadProjectContext(cwd));
  // Oxagen context-engine memory, opened asynchronously on mount.
  const memoryRef = useRef<SessionMemory | null>(null);
  // Source-of-truth message list (the state mirror), so streaming updates can be
  // computed synchronously without racing React's batched setState.
  const allRef = useRef<Message[]>([]);
  // Multi-turn conversation history fed back to the model each turn.
  const historyRef = useRef<ModelMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    let mem: SessionMemory | null = null;
    void openSessionMemory(cwd, `repl-${Date.now()}`).then((m) => {
      mem = m;
      memoryRef.current = m;
    });
    return () => {
      void mem?.close();
    };
  }, [cwd]);

  const commit = useCallback((next: Message[]) => {
    allRef.current = next;
    setMessages(next);
  }, []);

  const pushAssistant = useCallback(
    (content: string) => {
      commit([
        ...allRef.current,
        { role: "assistant", content, timestamp: Date.now() },
      ]);
    },
    [commit],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (streamingRef.current && abortRef.current) {
        abortRef.current.abort();
      } else {
        void memoryRef.current?.close();
        exit();
      }
    }
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      // ── Slash commands ──
      if (text === "/help") {
        pushAssistant(HELP);
        return;
      }
      if (text === "/clear") {
        allRef.current = [];
        historyRef.current = [];
        setMessages([]);
        return;
      }
      if (text.startsWith("/model")) {
        const slug = text.slice("/model".length).trim();
        if (slug) {
          setModel(slug);
          pushAssistant(`Model set to ${slug}.`);
        } else {
          pushAssistant(`Current model: ${modelRef.current}`);
        }
        return;
      }
      if (text === "/exit" || text === "/quit") {
        void memoryRef.current?.close();
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
      streamingRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      // This turn's streamed messages (tool annotations + assistant text).
      const turn: Message[] = [];
      let assistantOpen = false;
      const render = (): void => commit([...base, ...turn]);

      try {
        const result = await runAgent({
          prompt: text,
          history: historyRef.current,
          cwd,
          model: modelRef.current,
          readOnly: options.readOnly,
          projectContext: projectContextRef.current,
          memory: memoryRef.current,
          signal: controller.signal,
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
        setTurns((n) => n + 1);
      } catch (err) {
        const cancelled = controller.signal.aborted;
        turn.push({
          role: "assistant",
          content: cancelled
            ? "(cancelled)"
            : `Error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
        render();
      } finally {
        abortRef.current = null;
        streamingRef.current = false;
        setIsStreaming(false);
      }
    },
    [exit, commit, pushAssistant, cwd, options.readOnly],
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
              Backed by Oxagen's knowledge-graph context engine. Type /help for
              commands.
            </Text>
            {projectContextRef.current.sources.length > 0 && (
              <Text dimColor>
                Loaded rules: {projectContextRef.current.sources.join(", ")}
              </Text>
            )}
          </Box>
        ) : (
          messages.map((msg, i) => <MessageView key={i} msg={msg} />)
        )}
      </Box>

      {/* Status line */}
      <StatusLine
        model={model}
        readOnly={options.readOnly ?? false}
        turns={turns}
      />

      {/* Input */}
      <PromptInput onSubmit={handleSubmit} disabled={isStreaming} />
    </Box>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(options: ReplOptions = {}): Promise<void> {
  const { render: renderInk } = await import("ink");
  const { waitUntilExit } = renderInk(<ReplApp options={options} />);
  await waitUntilExit();
}
