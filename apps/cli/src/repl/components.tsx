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
import { formatUsd } from "../agent/model-router.js";
import type { StageEvent, StageKind, TurnTrace, JudgeVerdict } from "../agent/trace.js";

export interface Message {
  role: "user" | "assistant" | "tool" | "stage";
  content: string;
  timestamp: number;
  toolName?: string;
  streaming?: boolean;
  /** Present on `role: "stage"` messages — a live pipeline progress event. */
  stage?: StageEvent;
  /** When present, the message renders the full replay view for a turn. */
  trace?: TurnTrace;
}

export const HELP = [
  "Slash commands:",
  "  /help          show this help",
  "  /model [slug]  show or set the gateway model",
  "  /replay [n|id] show how a turn was handled (default: last turn)",
  "  /traces        list recent turns you can /replay",
  "  /pipeline [on|off]  toggle prompt evaluation + completeness judging",
  "  /verbose [on|off]   per-phase timing, model+token+cost breakdown, tool results",
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

// ── Pipeline stage badge ────────────────────────────────────────────────────

const STAGE_GLYPH: Record<StageKind, string> = {
  evaluate: "◇",
  enhance: "◆",
  route: "⊚",
  execute: "▸",
  judge: "⚖",
  revise: "↻",
  complete: "✓",
};

const STAGE_COLOR: Record<StageKind, string> = {
  evaluate: "#A78BFA",
  enhance: "#A78BFA",
  route: theme.cyan,
  execute: "#FBBF24",
  judge: "#34D399",
  revise: "#FB7185",
  complete: "#34D399",
};

/** A compact, dim line announcing one pipeline stage as it happens. */
export function StageBadge({ stage }: { stage: StageEvent }): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color={STAGE_COLOR[stage.kind]}>{STAGE_GLYPH[stage.kind]} </Text>
      <Text dimColor>{stage.label}</Text>
      {stage.detail ? <Text dimColor> · {stage.detail}</Text> : null}
    </Box>
  );
}

export function MessageView({ msg }: { msg: Message }): React.ReactElement {
  if (msg.trace) return <TraceView trace={msg.trace} />;
  if (msg.role === "stage" && msg.stage) return <StageBadge stage={msg.stage} />;
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
  pipelineOn,
  verboseOn,
}: {
  model: string;
  readOnly: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Whether the eval→enhance→judge pipeline is active (undefined = don't show). */
  pipelineOn?: boolean;
  /** Whether verbose telemetry capture is active (undefined = don't show). */
  verboseOn?: boolean;
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
        {pipelineOn !== undefined && (
          <Text dimColor>
            pipeline:
            <Text color={pipelineOn ? "#34D399" : "#FB7185"}>
              {pipelineOn ? "on" : "off"}
            </Text>
          </Text>
        )}
        {verboseOn && <Text color={theme.cyan}>verbose</Text>}
        {readOnly && <Text color="#FBBF24">read-only</Text>}
      </Box>
      <Box gap={2}>
        <Text dimColor>/help</Text>
        <Text dimColor>/replay</Text>
        <Text dimColor>esc·ctrl+c</Text>
      </Box>
    </Box>
  );
}

// ── Replay / Trace view ───────────────────────────────────────────────────────

/** A tiny 0–100 score bar: "completeness ███████░░░ 72/100". */
function scoreColor(score: number): string {
  if (score >= 70) return "#34D399";
  if (score >= 40) return "#FBBF24";
  return "#FB7185";
}

function ScoreBar({ label, score }: { label: string; score: number }): React.ReactElement {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 10);
  return (
    <Box>
      <Text dimColor>{label.padEnd(13)}</Text>
      <Text color={scoreColor(score)}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(10 - filled)}</Text>
      <Text dimColor> {score}/100</Text>
    </Box>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.cyan} bold>
        {title}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

function JudgeRoundView({
  verdict,
  round,
}: {
  verdict: JudgeVerdict;
  round: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={round > 0 ? 1 : 0}>
      <Box>
        <Text dimColor>round {round + 1}: </Text>
        <Text color={verdict.complete ? "#34D399" : "#FB7185"} bold>
          {verdict.complete ? "COMPLETE" : "INCOMPLETE"}
        </Text>
        <Text dimColor>
          {" "}
          · {verdict.confidence}% confident · advisor {verdict.model.split("/").pop()}
          {verdict.fallback ? " (heuristic)" : ""}
        </Text>
      </Box>
      {verdict.findings.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {verdict.findings.map((f, i) => (
            <Text key={i} color="#FB7185">
              ✗ {f}
            </Text>
          ))}
        </Box>
      )}
      {verdict.reasoning ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {verdict.reasoning}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Full replay of one turn — the original prompt, how it was evaluated, the context
 * the enhancer injected, the model that was selected and why, and the advisor's
 * completeness verdict(s) with chain of thought. This is the user's window into
 * everything the pipeline did on their behalf.
 */
export function TraceView({ trace }: { trace: TurnTrace }): React.ReactElement {
  const { evaluation: ev, enhancement: en } = trace;
  const cost = formatUsd(trace.usage.costUsd);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text color={theme.violet} bold>
          ↻ replay
        </Text>
        <Text dimColor>
          {" "}
          {trace.id} · {Math.round(trace.durationMs / 100) / 10}s · {cost} ·{" "}
          {trace.finalComplete ? (
            <Text color="#34D399">complete</Text>
          ) : (
            <Text color="#FB7185">gaps remain</Text>
          )}
        </Text>
      </Box>

      <Section title="1 · Original prompt">
        <Text wrap="wrap">{trace.originalPrompt}</Text>
      </Section>

      <Section title={`2 · Evaluation${ev.fallback ? " (heuristic)" : ` · ${ev.model.split("/").pop()}`}`}>
        <ScoreBar label="completeness" score={ev.completeness} />
        <ScoreBar label="complexity" score={ev.complexity} />
        {ev.missing.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>missing from prompt:</Text>
            {ev.missing.map((m, i) => (
              <Text key={i} color="#FBBF24">
                ? {m}
              </Text>
            ))}
          </Box>
        )}
        {ev.removed.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>pruned as low-value:</Text>
            {ev.removed.map((r, i) => (
              <Text key={i} dimColor>
                − {r}
              </Text>
            ))}
          </Box>
        )}
        {ev.reasoning ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {ev.reasoning}
            </Text>
          </Box>
        ) : null}
      </Section>

      {ev.refinedPrompt !== trace.originalPrompt && (
        <Section title="3 · Refined prompt (noise removed)">
          <Text wrap="wrap">{ev.refinedPrompt}</Text>
        </Section>
      )}

      <Section title={`4 · Injected context · ${en.source}`}>
        {en.resolved.length > 0 ? (
          <Text dimColor>
            code refs: <Text color={theme.cyan}>{en.resolved.join(", ")}</Text>
          </Text>
        ) : (
          <Text dimColor>no code-graph references resolved</Text>
        )}
        <Text dimColor>recalled lessons: {en.lessonCount}</Text>
        {en.context ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {en.context.length > 600 ? en.context.slice(0, 600) + "…" : en.context}
            </Text>
          </Box>
        ) : null}
      </Section>

      <Section title="5 · Model selected">
        <Text>
          <Text color={theme.cyan} bold>
            {trace.selectedModel.split("/").pop()}
          </Text>
          <Text dimColor> ({trace.selectedTier}) — {trace.selectionRationale}</Text>
        </Text>
      </Section>

      <Section title="6 · Completeness review (advisor)">
        {trace.judgeRounds.length === 0 ? (
          <Text dimColor>not judged (bare mode)</Text>
        ) : (
          trace.judgeRounds.map((v, i) => <JudgeRoundView key={i} verdict={v} round={i} />)
        )}
      </Section>

      <Box marginTop={1}>
        <Text dimColor>
          {trace.steps} steps · {trace.filesTouched.length} file(s) touched
          {trace.filesTouched.length > 0
            ? `: ${trace.filesTouched.slice(0, 5).join(", ")}`
            : ""}
        </Text>
      </Box>
    </Box>
  );
}

/** One-line summary of a trace for the `/traces` list. */
export function summarizeTrace(trace: TurnTrace, index: number): string {
  const mark = trace.finalComplete ? "✓" : "✗";
  const prompt =
    trace.originalPrompt.length > 56
      ? trace.originalPrompt.slice(0, 56) + "…"
      : trace.originalPrompt;
  const model = trace.selectedModel.split("/").pop();
  return `${index + 1}. ${mark} ${prompt}  [${model} · ${formatUsd(trace.usage.costUsd)}]`;
}
