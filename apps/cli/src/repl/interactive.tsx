/**
 * Interactive REPL — the default `oxagen` experience.
 *
 * Full-screen Ink TUI with:
 *   - Scrollable conversation history (user prompts + assistant responses)
 *   - A thinking indicator (spinner + elapsed time + live token estimate) and a
 *     session token counter in the status bar
 *   - Multi-turn history, project rules, and Oxagen context-engine memory
 *   - Slash commands (/help, /model, /clear, /exit), prompt queue, Esc/Ctrl-C cancel
 *
 * Presentational pieces live in ./components; this file is the container.
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModelMessage } from "ai";
import { theme } from "../tui/theme.js";
import { runTurn } from "../agent/pipeline.js";
import { resolveModelId } from "../agent/model.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory, type SessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openTraceStore } from "../agent/trace-store.js";
import {
  HELP,
  MessageView,
  PromptInput,
  StatusLine,
  ThinkingIndicator,
  summarizeTrace,
  type Message,
} from "./components.js";
import pkg from "../../package.json" with { type: "json" };

export interface ReplOptions {
  model?: string;
  readOnly?: boolean;
  /** Start with the eval→enhance→judge pipeline disabled (bare agent). */
  bare?: boolean;
}

// ── Main App ──────────────────────────────────────────────────────────────────

function summarizeInput(input: unknown): string {
  if (input == null) return "";
  const text =
    typeof input === "object" ? JSON.stringify(input) : String(input);
  return text.length > 100 ? text.slice(0, 100) + "…" : text;
}

export function ReplApp({
  options,
}: {
  options: ReplOptions;
}): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState<string>(resolveModelId(options.model));
  const [turns, setTurns] = useState(0);
  // Cumulative session token usage (exact, from the model's reported usage).
  const [usage, setUsage] = useState<{ input: number; output: number }>({
    input: 0,
    output: 0,
  });
  // When the active turn began (drives the thinking indicator); null when idle.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  // Output chars streamed this turn, for the live token estimate in the indicator.
  const streamCharsRef = useRef(0);
  // Prompts submitted while a turn is in flight wait here and run FIFO when the
  // current turn finishes (Claude Code-style prompt queue). `queued` drives the
  // visible list; `queueRef` is the synchronous source of truth the pump reads.
  const [queued, setQueued] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);

  // Whether the eval→enhance→judge pipeline is active (vs. the bare agent).
  const [pipelineOn, setPipelineOn] = useState(!options.bare);
  const bareRef = useRef(options.bare ?? false);

  const cwd = process.cwd();
  // Project rules (CLAUDE.md/AGENTS.md) loaded once for the session.
  const projectContextRef = useRef(loadProjectContext(cwd));
  // Oxagen context-engine memory, opened asynchronously on mount.
  const memoryRef = useRef<SessionMemory | null>(null);
  // Fleet memory (weighted lessons) and the per-turn trace store, both synchronous.
  const fleetMemoryRef = useRef(openFleetMemory(cwd));
  const traceStoreRef = useRef(openTraceStore(cwd));
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

  const cancelTurn = useCallback(() => {
    // Cancel the in-flight turn and drop anything queued behind it.
    queueRef.current = [];
    setQueued([]);
    abortRef.current?.abort();
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (streamingRef.current) cancelTurn();
      return;
    }
    if (key.ctrl && input === "c") {
      if (streamingRef.current && abortRef.current) {
        cancelTurn();
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
      if (text.startsWith("/replay")) {
        const arg = text.slice("/replay".length).trim();
        const trace = traceStoreRef.current.resolve(arg);
        if (!trace) {
          pushAssistant(
            arg
              ? `No turn matches "${arg}". Try /traces to list recent turns.`
              : "No turns recorded yet. Run a prompt first.",
          );
        } else {
          commit([
            ...allRef.current,
            { role: "assistant", content: "", trace, timestamp: Date.now() },
          ]);
        }
        return;
      }
      if (text === "/traces") {
        const traces = traceStoreRef.current.list();
        pushAssistant(
          traces.length === 0
            ? "No turns recorded yet."
            : "Recent turns (use /replay <n>):\n" +
                traces.slice(0, 10).map((t, i) => summarizeTrace(t, i)).join("\n"),
        );
        return;
      }
      if (text.startsWith("/pipeline")) {
        const arg = text.slice("/pipeline".length).trim().toLowerCase();
        if (arg === "off") {
          bareRef.current = true;
          setPipelineOn(false);
          pushAssistant("Pipeline OFF — running the bare agent (no eval/enhance/judge).");
        } else if (arg === "on") {
          bareRef.current = false;
          setPipelineOn(true);
          pushAssistant("Pipeline ON — prompts are evaluated, enhanced, and judged for completeness.");
        } else {
          pushAssistant(`Pipeline is ${bareRef.current ? "OFF" : "ON"}. Use /pipeline on|off.`);
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
      setTurnStartedAt(Date.now());
      streamCharsRef.current = 0;
      const controller = new AbortController();
      abortRef.current = controller;

      // This turn's streamed messages (tool annotations + assistant text).
      const turn: Message[] = [];
      let assistantOpen = false;
      const render = (): void => commit([...base, ...turn]);

      try {
        const result = await runTurn({
          prompt: text,
          history: historyRef.current,
          cwd,
          model: modelRef.current,
          readOnly: options.readOnly,
          bare: bareRef.current,
          projectContext: projectContextRef.current,
          memory: memoryRef.current,
          fleetMemory: fleetMemoryRef.current,
          signal: controller.signal,
          onStage: (stage) => {
            turn.push({
              role: "stage",
              stage,
              content: stage.label,
              timestamp: Date.now(),
            });
            assistantOpen = false;
            render();
          },
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
            streamCharsRef.current += delta.length;
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
        // Persist the turn trace so /replay can show how it was handled.
        traceStoreRef.current.record(result.trace);
        setTurns((n) => n + 1);
        setUsage((u) => ({
          input: u.input + (result.usage.inputTokens ?? 0),
          output: u.output + (result.usage.outputTokens ?? 0),
        }));
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
        setTurnStartedAt(null);
      }
  }, []);

  // The pump reads the latest handleSubmit via a ref so it never closes over a
  // stale version, while staying a stable callback itself.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // Single sequential consumer: drains the queue one prompt at a time, awaiting
  // each turn before starting the next. Re-entrancy is guarded so submissions
  // that arrive mid-drain just extend the queue the running pump is reading.
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current[0] as string;
        queueRef.current = queueRef.current.slice(1);
        setQueued(queueRef.current);
        await handleSubmitRef.current(next);
      }
    } finally {
      pumpingRef.current = false;
    }
  }, []);

  // Every submission goes through the queue. When idle, the pump picks it up
  // immediately; when a turn is in flight, it waits its turn (FIFO).
  const enqueue = useCallback(
    (text: string) => {
      queueRef.current = [...queueRef.current, text];
      setQueued(queueRef.current);
      void pump();
    },
    [pump],
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

      {/* Queued prompts (submitted while a turn is running) */}
      {queued.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {queued.map((q, i) => (
            <Box key={i}>
              <Text color="#FBBF24">{"⧗ queued: "}</Text>
              <Text dimColor wrap="truncate">
                {q}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Thinking indicator — visible only while a turn is in flight */}
      {isStreaming && turnStartedAt !== null && (
        <ThinkingIndicator
          startedAt={turnStartedAt}
          getTokens={() => Math.round(streamCharsRef.current / 4)}
        />
      )}

      {/* Status line */}
      <StatusLine
        model={model}
        readOnly={options.readOnly ?? false}
        turns={turns}
        inputTokens={usage.input}
        outputTokens={usage.output}
        pipelineOn={pipelineOn}
      />

      {/* Input — stays live during a turn; submissions queue instead of blocking */}
      <PromptInput onSubmit={enqueue} busy={isStreaming} />
    </Box>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(options: ReplOptions = {}): Promise<void> {
  const { render: renderInk } = await import("ink");
  const { waitUntilExit } = renderInk(<ReplApp options={options} />);
  await waitUntilExit();
}
