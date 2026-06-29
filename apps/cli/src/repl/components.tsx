/**
 * Presentational components for the REPL.
 *
 * Kept deliberately free of heavy imports (no agent loop, no context engine) so
 * they render instantly and are unit-testable in isolation with
 * ink-testing-library.
 */
import { Box, Text, useInput, useStdout } from "ink";
import React, { useState, useEffect } from "react";
import { theme } from "../tui/theme.js";
import { formatUsd } from "../agent/model-router.js";
import { AGENT_TURN_TIMEOUT_MS } from "../agent/timeouts.js";
import { getToolEmoji } from "../agent/tool-formatter.js";
import { SlashMenu } from "./slash-menu.js";
import {
  slashQuery,
  filterSlashCatalog,
  type SlashCatalogEntry,
} from "../slash/catalog.js";
import type { StageEvent, StageKind, TurnTrace, JudgeVerdict } from "../agent/trace.js";
import type { ApprovalRequest, ApprovalResponse, PermissionMode } from "../agent/permissions.js";

/** Layout mode for the REPL: inline scrollback vs. alternate-screen fullscreen. */
export type TuiMode = "compact" | "fullscreen";

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
  "Slash commands (type / to browse them with descriptions):",
  "  /help          show this help",
  "  /tui [compact|fullscreen]  switch the terminal layout (omit to toggle)",
  "  /model [slug]  show or set the gateway model",
  "  /mode [ask|auto-edit|bypass|readonly]  show or set the permission mode",
  "  /replay [n|id] show how a turn was handled (default: last turn)",
  "  /traces        list recent turns you can /replay",
  "  /pipeline [on|off]  toggle prompt evaluation + completeness judging",
  "  /verbose [on|off]   per-phase timing, model+token+cost breakdown, tool results",
  "  /clear         reset the conversation",
  "  /exit, /quit   quit",
  "Type / to open the command menu — 📦 marks built-in & CLI commands; every",
  "`oxagen --help` command is browsable there too (custom commands show no glyph).",
  "Permission prompt: y allow once · a allow + remember · n/Esc deny",
  "Esc / Ctrl-C     cancel the current turn (Ctrl-C quits when idle)",
].join("\n");

/** Friendly label for a permission mode (matches the `/mode` argument spelling). */
export function modeLabel(mode: PermissionMode): string {
  return mode === "acceptEdits" ? "auto-edit" : mode === "readonly" ? "read-only" : mode;
}

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
  catalog = [],
}: {
  onSubmit: (text: string) => void;
  /** A turn is in flight. The input stays live — submissions queue (Claude
   *  Code-style) instead of being blocked — but the glyph shows the busy state. */
  busy: boolean;
  /** Slash-command catalog powering the live typeahead menu (empty = no menu). */
  catalog?: ReadonlyArray<SlashCatalogEntry>;
}): React.ReactElement {
  const [value, setValue] = useState("");
  // Highlighted suggestion + whether the user dismissed the menu (Esc). Both
  // reset to their defaults whenever the buffer changes via typing.
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const { stdout } = useStdout();

  // Derive the live typeahead state from the current buffer. The menu is open
  // only while the buffer is a single `/word` token and the user hasn't
  // dismissed it.
  const query = dismissed ? null : slashQuery(value);
  const suggestions = query === null ? [] : filterSlashCatalog(catalog, query);
  const menuOpen = suggestions.length > 0;
  // `selected` may lag the (shrinking) suggestion list; clamp for rendering/use.
  const sel = suggestions.length === 0 ? 0 : Math.min(selected, suggestions.length - 1);
  const cols = stdout?.columns ?? 80;
  const menuWidth = Math.min(Math.max(cols - 2, 40), 100);

  const resetInput = (): void => {
    setValue("");
    setSelected(0);
    setDismissed(false);
  };

  useInput((input, key) => {
    // ── Typeahead navigation (only while the menu is open) ──
    if (menuOpen) {
      if (key.downArrow) {
        setSelected((s) => (Math.min(s, suggestions.length - 1) + 1) % suggestions.length);
        return;
      }
      if (key.upArrow) {
        setSelected(
          (s) => (Math.min(s, suggestions.length - 1) - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (key.tab) {
        const pick = suggestions[sel];
        if (pick) {
          // Complete to `/name `; commands taking args keep the trailing space
          // (and a closed menu) so the user types arguments next.
          setValue(`/${pick.name}${pick.argumentHint ? " " : ""}`);
          setSelected(0);
          setDismissed(false);
        }
        return;
      }
      if (key.escape) {
        setDismissed(true);
        return;
      }
      if (key.return && !key.shift) {
        const pick = suggestions[sel];
        if (pick) {
          const exact = value.trim() === `/${pick.name}`;
          if (exact || !pick.argumentHint) {
            // Fully-typed, or an argument-free command: run it now.
            onSubmit(`/${pick.name}`);
            resetInput();
          } else {
            // Selected a different/partial command that takes args: complete it
            // and keep editing rather than firing the wrong command.
            setValue(`/${pick.name} `);
            setSelected(0);
            setDismissed(false);
          }
        }
        return;
      }
    }

    // ── Plain line editing ──
    if (key.tab) return; // never insert a literal tab character
    if (key.return && !key.shift) {
      if (value.trim()) {
        onSubmit(value.trim());
        resetInput();
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setSelected(0);
      setDismissed(false);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
      setSelected(0);
      setDismissed(false);
    }
  });

  return (
    <Box flexDirection="column">
      {menuOpen && <SlashMenu entries={suggestions} selectedIndex={sel} width={menuWidth} />}
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
    </Box>
  );
}

// ── Permission approval prompt ─────────────────────────────────────────────────

/**
 * Shown in place of the input row while the agent is blocked waiting for the
 * human to approve a mutating tool call. Captures a single keystroke:
 * `y` allow once · `a` allow and remember (auto-allow identical calls this
 * session) · `n` / Esc deny. The pending promise is resolved by the container.
 */
export function ApprovalPrompt({
  req,
  onResolve,
}: {
  req: ApprovalRequest;
  onResolve: (response: ApprovalResponse) => void;
}): React.ReactElement {
  useInput((input, key) => {
    const ch = (input || "").toLowerCase();
    if (ch === "y") onResolve({ decision: "allow" });
    else if (ch === "a") onResolve({ decision: "allow", remember: true });
    else if (ch === "n" || key.escape) onResolve({ decision: "deny" });
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1}>
      <Box>
        <Text color="#FBBF24" bold>
          {"⚠ permission · "}
        </Text>
        <Text dimColor>{req.reason}</Text>
      </Box>
      <Box>
        <Text wrap="truncate-end">{req.summary}</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text>
          <Text color="#34D399" bold>
            y
          </Text>
          <Text dimColor> allow once</Text>
        </Text>
        <Text>
          <Text color={theme.cyan} bold>
            a
          </Text>
          <Text dimColor> allow + remember</Text>
        </Text>
        <Text>
          <Text color="#FB7185" bold>
            n
          </Text>
          <Text dimColor> deny (Esc)</Text>
        </Text>
      </Box>
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
    const emoji = getToolEmoji(msg.toolName ?? "");
    return (
      <Box paddingX={1} marginY={1} flexDirection="column">
        <Box>
          <Text>{emoji + " "}</Text>
          <Text dimColor>{msg.toolName?.toLowerCase() ?? "tool"}</Text>
          <Text dimColor>{"("}</Text>
          <Text wrap="truncate">{msg.content}</Text>
          <Text dimColor>{")"}</Text>
        </Box>
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

/** Width (cells) of the turn-budget bar in the thinking indicator. */
const BUDGET_BAR_WIDTH = 6;

/**
 * Animated "the agent is working" indicator: a braille spinner, elapsed
 * seconds, a live output-token estimate, and a best-guess "time remaining" bar
 * toward the turn's auto-cancel deadline. It runs its own ~100ms timer so it
 * animates independently of streaming updates.
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

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const elapsed = Math.round(elapsedMs / 1000);
  const tokens = getTokens();

  // Best-guess "time remaining" = the budget left before the turn hits its
  // auto-cancel backstop (AGENT_TURN_TIMEOUT_MS). The bar fills as the turn runs
  // and the remaining time warms dim → amber → red as the deadline nears, so a
  // slow turn shows honest progress instead of an opaque, possibly-hung spinner.
  const remainingSec = Math.ceil(Math.max(0, AGENT_TURN_TIMEOUT_MS - elapsedMs) / 1000);
  const frac = Math.min(1, elapsedMs / AGENT_TURN_TIMEOUT_MS);
  const filled = Math.round(frac * BUDGET_BAR_WIDTH);
  const bar = "▰".repeat(filled) + "▱".repeat(BUDGET_BAR_WIDTH - filled);
  const remainingColor =
    remainingSec <= 30 ? "#F87171" : remainingSec <= 90 ? "#FBBF24" : undefined;

  return (
    <Box paddingX={1}>
      <Text color="#FBBF24" bold>
        {SPINNER[frame % SPINNER.length]}{" "}
      </Text>
      <Text color="#FBBF24">Thinking… </Text>
      <Text dimColor>
        {elapsed}s{tokens > 0 ? ` · ~${humanizeTokens(tokens)} tok` : ""}
        {" · "}
        {bar}{" "}
      </Text>
      <Text dimColor={remainingColor === undefined} color={remainingColor}>
        ~{remainingSec}s left
      </Text>
      <Text dimColor> · esc to cancel</Text>
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
  mode,
  tuiMode,
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
  /** Current permission posture (undefined = fall back to the read-only chip). */
  mode?: PermissionMode;
  /** Current layout mode (undefined = don't show the chip). */
  tuiMode?: TuiMode;
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
        {tuiMode && (
          <Text dimColor>
            layout:<Text color={theme.violet}>{tuiMode}</Text>
          </Text>
        )}
        {verboseOn && <Text color={theme.cyan}>verbose</Text>}
        {readOnly && <Text color="#FBBF24">read-only</Text>}
        {mode ? (
          <Text dimColor>
            mode:
            <Text
              color={
                mode === "bypass"
                  ? "#FB7185"
                  : mode === "ask"
                    ? theme.cyan
                    : "#FBBF24"
              }
            >
              {modeLabel(mode)}
            </Text>
          </Text>
        ) : (
          readOnly && <Text color="#FBBF24">read-only</Text>
        )}
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
