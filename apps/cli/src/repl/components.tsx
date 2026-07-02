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
import {
  getToolEmoji,
  getToolAccent,
  toolDisplayLabel,
  isSubagentDispatch,
} from "../agent/tool-formatter.js";
import { DiffView } from "./diff-view.js";
import type { DiffTheme } from "../tui/terminal-theme.js";
import { SlashMenu } from "./slash-menu.js";
import {
  slashQuery,
  filterSlashCatalog,
  type SlashCatalogEntry,
} from "../slash/catalog.js";
import type { StageEvent, StageKind, TurnTrace, JudgeVerdict } from "../agent/trace.js";
import type { ApprovalRequest, ApprovalResponse, PermissionMode } from "../agent/permissions.js";

export interface Message {
  role: "user" | "assistant" | "reasoning" | "tool" | "stage" | "diff";
  content: string;
  timestamp: number;
  toolName?: string;
  streaming?: boolean;
  /** Present on `role: "stage"` messages — a live pipeline progress event. */
  stage?: StageEvent;
  /** Present on `role: "diff"` messages — the unified git diff to render. */
  diff?: string;
  /** Present on `role: "diff"` messages — the relative paths the diff touches. */
  changedFiles?: string[];
  /** When present, the message renders the full replay view for a turn. */
  trace?: TurnTrace;
  /** When present, the message renders the end-of-turn summary card. */
  summary?: TurnSummary;
}

/**
 * Headline outcome of a turn, rendered as a boxed card once the work settles.
 * Only fields the pipeline actually produces are populated — completeness +
 * confidence from the advisor judge, the files the agent touched, and the
 * priced cost. Test/PR/CI status is intentionally absent (the REPL turn does
 * not run those) rather than shown as fabricated data.
 */
export interface TurnSummary {
  /** Whether the advisor judged the work complete (or the turn simply finished). */
  complete: boolean;
  /** Advisor confidence 0–100 → shown as the "quality" score. Absent in bare mode. */
  quality?: number;
  /** Relative paths the agent wrote or edited. */
  filesTouched: string[];
  /** Priced cost of the turn, USD. */
  costUsd: number;
  /** True when the pipeline ran (judged); false for the bare agent. */
  judged: boolean;
  /** Present on `role: "diff"` — the unified git diff to render (highlighted). */
  diff?: string;
  /** Present on `role: "diff"` — the changed-file paths, for the header line. */
  changedFiles?: string[];
}

export const HELP = [
  "Slash commands (type / to browse them with descriptions):",
  "  /help          show this help",
  "  /model [slug]  show or set the gateway model",
  "  /mode [ask|auto-edit|bypass|readonly]  show or set the permission mode",
  "  /replay [n|id] show how a turn was handled (default: last turn)",
  "  /traces        list recent turns you can /replay",
  "  /pipeline [on|off]  toggle prompt evaluation + completeness judging",
  "  /verbose [on|off]   per-phase timing, model+token+cost breakdown, tool results",
  "  /hud           toggle the heads-up display of all agents running this session",
  "  /panel         pin/hide the Agent Team + Task Progress side panel (right dock)",
  "  /clear         reset the conversation",
  "  /exit, /quit   quit",
  "Type / to open the command menu — 📦 marks built-in & CLI commands; every",
  "`oxagen --help` command is browsable there too (custom commands show no glyph).",
  "Permission prompt: y allow once · a allow + remember · n/Esc deny",
  "  Esc            stop the turn · press Esc twice to reset the conversation (confirm y/yes)",
  "  Ctrl-C         cancel the current turn (quits when idle)",
].join("\n");

/** Friendly label for a permission mode (matches the `/mode` argument spelling). */
export function modeLabel(mode: PermissionMode): string {
  return mode === "acceptEdits" ? "auto-edit" : mode === "readonly" ? "read-only" : mode;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Compact token count: 980 → "980", 1234 → "1.2k", 23000 → "23k", 87.1e6 → "87.1M". */
export function humanizeTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

// ── Prompt Input ──────────────────────────────────────────────────────────────

export function PromptInput({
  onSubmit,
  busy,
  catalog = [],
  focused = true,
  inject,
  onMenuOpenChange,
}: {
  onSubmit: (text: string) => void;
  /** A turn is in flight. The input stays live — submissions queue (Claude
   *  Code-style) instead of being blocked — but the glyph shows the busy state. */
  busy: boolean;
  /** Slash-command catalog powering the live typeahead menu (empty = no menu). */
  catalog?: ReadonlyArray<SlashCatalogEntry>;
  /**
   * Whether the input owns the keyboard. When false the parent has moved focus
   * into the side panel (arrow-key navigation), so the input ignores every
   * keystroke and hides its block cursor — the panel handler owns arrows,
   * Ctrl-E, and Ctrl-X until focus returns here. Defaults true (standalone use).
   */
  focused?: boolean;
  /**
   * External buffer injection. When `nonce` changes the buffer is replaced with
   * `text` (cursor to end) — used to recall queued prompts for editing (Up),
   * load a task's title for editing (Ctrl-E on a task), and clear the bar as
   * focus moves between agents. The menu is suppressed for injected text so a
   * recalled slash string doesn't reopen the typeahead unbidden.
   */
  inject?: { text: string; nonce: number };
  /** Notifies the parent when the typeahead menu opens/closes so it knows
   *  whether the arrow keys belong to menu navigation or panel navigation. */
  onMenuOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  // Highlighted suggestion + whether the user dismissed the menu (Esc). Both
  // reset to their defaults whenever the buffer changes via typing.
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const { stdout } = useStdout();

  // Replace the buffer when the parent injects new text (queue recall, task
  // edit, or a clear). Keyed on the nonce so the same text can be re-injected
  // (e.g. clearing to "" twice in a row). `dismissed` is set so injected text
  // never pops the typeahead; typing afterwards clears it as usual.
  const injectNonce = inject?.nonce;
  useEffect(() => {
    if (injectNonce === undefined) return;
    setValue(inject?.text ?? "");
    setSelected(0);
    setDismissed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on nonce change
  }, [injectNonce]);

  // Derive the live typeahead state from the current buffer. The menu is open
  // only while the buffer is a single `/word` token and the user hasn't
  // dismissed it.
  const query = dismissed ? null : slashQuery(value);
  const suggestions = query === null ? [] : filterSlashCatalog(catalog, query);
  const menuOpen = suggestions.length > 0;
  // Surface menu open/close to the parent so it can route arrow keys: while the
  // menu is open the arrows navigate suggestions; while it's closed they belong
  // to the parent (Up = recall queue, Down = enter the side panel).
  useEffect(() => {
    onMenuOpenChange?.(menuOpen);
  }, [menuOpen, onMenuOpenChange]);
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
    // When focus has moved into the side panel the input owns no keys: the
    // parent's panel handler drives arrows / Ctrl-E / Ctrl-X. Ignoring here
    // (rather than in the parent) keeps a single, race-free owner per keystroke.
    if (!focused) return;

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
      {/* The bordered input keeps a constant height (one text row inside a round
          border = 3 rows). minHeight + flexShrink={0} guarantee it never
          collapses or is squeezed as the conversation above grows. */}
      <Box
        borderStyle="round"
        borderColor={!focused ? theme.dim : busy ? "#FBBF24" : theme.cyan}
        paddingX={1}
        minHeight={3}
        flexShrink={0}
      >
        <Text color={!focused ? theme.dim : busy ? "#FBBF24" : theme.cyan} bold>
          {busy ? "⧗ " : "❯ "}
        </Text>
        <Text dimColor={!focused}>
          {value}
          {/* The block cursor shows only while the input holds focus; when the
              panel has focus the bar dims and drops the cursor so the highlight
              clearly lives in the side panel instead. */}
          {focused ? <Text color={theme.cyan}>█</Text> : null}
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

/**
 * A compact line announcing one pipeline stage as it happens. Rendered in the
 * same bracketed-chip grammar as tool calls, but with the stage's own dim glyph
 * (not the ⚡ action bolt) so pipeline chatter stays visually subordinate to the
 * concrete actions the agent takes.
 */
export function StageBadge({ stage }: { stage: StageEvent }): React.ReactElement {
  const color = STAGE_COLOR[stage.kind];
  return (
    <Box paddingX={1}>
      <Text color={color}>{STAGE_GLYPH[stage.kind]} </Text>
      <Text color={color} dimColor>
        [{STAGE_LABEL[stage.kind]}]
      </Text>
      <Text>{"  "}</Text>
      <Text dimColor wrap="truncate-end">
        {stage.label}
      </Text>
      {stage.detail ? <Text dimColor> · {stage.detail}</Text> : null}
    </Box>
  );
}

/** Title-cased chip label for each pipeline stage. */
const STAGE_LABEL: Record<StageKind, string> = {
  evaluate: "Evaluate",
  enhance: "Enhance",
  route: "Route",
  execute: "Execute",
  judge: "Review",
  revise: "Revise",
  complete: "Complete",
};

// ── Action chips ────────────────────────────────────────────────────────────

/** The ⚡ action bolt that gutters every concrete agent action. */
const ACTION_BOLT = "⚡";

/**
 * One tool call, rendered as `⚡ [📖 Read]  src/foo.ts`. The bracket is tinted
 * by what the tool does (see getToolAccent) so writes/deletes/commands/reads are
 * distinguishable at a glance; the argument trails, truncated to one line.
 */
function ToolChip({ msg }: { msg: Message }): React.ReactElement {
  const name = msg.toolName ?? "tool";
  const subagent = isSubagentDispatch(name);
  // Subagent delegation gets its own grammar (`⚡ [🚀 Task]  slug → what`) and a
  // violet accent; every other tool keeps the amber bolt with a use-colored chip.
  const accent = subagent ? "#A78BFA" : getToolAccent(name);
  return (
    <Box paddingX={1} marginTop={1}>
      <Text color={subagent ? accent : "#FBBF24"} bold>
        {ACTION_BOLT}{" "}
      </Text>
      <Text color={accent}>
        [{getToolEmoji(name)} {subagent ? "Task" : toolDisplayLabel(name)}]
      </Text>
      <Text>{"  "}</Text>
      <Text dimColor={!subagent} wrap="truncate-end">
        {msg.content}
      </Text>
    </Box>
  );
}

/**
 * A code-change message: a header naming the changed files, then the unified
 * git diff rendered with syntax highlighting in a theme matched to the terminal
 * background (light diff on light terminals, dark on dark).
 */
export function DiffMessage({
  msg,
  theme: diffTheme,
}: {
  msg: Message;
  theme?: DiffTheme;
}): React.ReactElement {
  const files = msg.changedFiles ?? [];
  const header =
    files.length === 0
      ? "code changes"
      : files.length === 1
        ? files[0]!
        : `${files.length} files changed`;
  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      <Box>
        <Text color={theme.violet} bold>
          {"◆ "}
        </Text>
        <Text dimColor>{header}</Text>
        {files.length > 1 ? (
          <Text dimColor> · {files.slice(0, 4).join(", ")}{files.length > 4 ? " …" : ""}</Text>
        ) : null}
      </Box>
      <DiffView diff={msg.diff ?? ""} theme={diffTheme} />
    </Box>
  );
}

export function MessageView({
  msg,
  diffTheme,
}: {
  msg: Message;
  /** Theme for `role: "diff"` rendering; derived from the terminal background. */
  diffTheme?: DiffTheme;
}): React.ReactElement {
  if (msg.trace) return <TraceView trace={msg.trace} />;
  if (msg.summary) return <TurnSummaryView summary={msg.summary} />;
  if (msg.role === "diff" && msg.diff) return <DiffMessage msg={msg} theme={diffTheme} />;
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

  if (msg.role === "reasoning") {
    // The model's chain-of-thought, rendered dim under a 💭 label so it reads as
    // an aside distinct from the answer. Shown live so the user sees every step
    // of the agent's thinking, not just its conclusion.
    return (
      <Box paddingX={1} marginY={0} flexDirection="column">
        <Text dimColor wrap="wrap">
          <Text color={theme.violet}>💭 thinking </Text>
          {msg.content}
          {msg.streaming && <Text color={theme.violet}>▊</Text>}
        </Text>
      </Box>
    );
  }

  if (msg.role === "tool") return <ToolChip msg={msg} />;

  // assistant — Oxagen speaking. A violet ◆ marker gutters the block so the
  // agent's prose is instantly separable from tool output and thinking asides.
  return (
    <Box paddingX={1} marginY={0} flexDirection="column">
      <Text wrap="wrap">
        <Text color={theme.violet} bold>
          ◆{" "}
        </Text>
        {msg.content}
        {msg.streaming && <Text color={theme.cyan}>▊</Text>}
      </Text>
    </Box>
  );
}

// ── End-of-turn summary card ──────────────────────────────────────────────────

/** One right-aligned label/value row inside the summary card. */
function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{label.padEnd(9)}</Text>
      <Text>{children}</Text>
    </Box>
  );
}

/**
 * The headline outcome of a turn, as a rounded card: the completeness verdict
 * and advisor "quality" score, the files touched, and the priced cost. The
 * border warms green when complete and amber when the judge still sees gaps.
 */
export function TurnSummaryView({ summary }: { summary: TurnSummary }): React.ReactElement {
  const { complete, quality, filesTouched, costUsd, judged } = summary;
  const color = complete ? "#34D399" : "#FBBF24";
  const files =
    filesTouched.length === 0
      ? "none"
      : filesTouched.length === 1
        ? (filesTouched[0] as string)
        : `${filesTouched[0]} (+${filesTouched.length - 1})`;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginY={1}
      alignSelf="flex-start"
    >
      <Box>
        <Text color={color} bold>
          {complete ? "✓ complete" : "⚠ gaps remain"}
        </Text>
        {judged && typeof quality === "number" ? (
          <>
            <Text dimColor>{"     quality "}</Text>
            <Text color={scoreColor(quality)} bold>
              {quality}/100
            </Text>
          </>
        ) : null}
      </Box>
      {!judged ? (
        <SummaryRow label="review">
          <Text dimColor>not judged (bare mode)</Text>
        </SummaryRow>
      ) : null}
      <SummaryRow label="files">
        <Text color={filesTouched.length > 0 ? theme.cyan : undefined} dimColor={filesTouched.length === 0}>
          {files}
        </Text>
      </SummaryRow>
      <SummaryRow label="cost">
        <Text color="#FBBF24">{formatUsd(costUsd)}</Text>
      </SummaryRow>
    </Box>
  );
}

// ── Thinking Indicator ────────────────────────────────────────────────────────

/**
 * After this many seconds with no *completed* call (progress), the turn is close
 * to the inactivity guard's window and we warn the user. This is NOT a turn cap —
 * a turn runs as long as calls keep completing (see agent/timeouts.ts). It just
 * signals "nothing has landed in a while" so a genuinely hung turn is visible.
 */
const IDLE_WARN_SEC = 60;

/**
 * Animated "the agent is working" indicator: a braille spinner, elapsed
 * seconds, a live output-token estimate, and — crucially — seconds since the
 * last completed call (progress). There is NO countdown to an auto-cancel
 * deadline, because a turn is bounded by progress and per-call timeouts, not by
 * total elapsed time: long, healthy work must not look like it is "running out
 * of time". The idle figure warms dim → amber → red only when progress genuinely
 * stalls. It runs its own ~100ms timer so it animates independently of streaming.
 */
export function ThinkingIndicator({
  startedAt,
  getTokens,
  getLastProgressAt,
}: {
  startedAt: number;
  getTokens: () => number;
  /** Live getter for the timestamp of the last completed call (delta/tool/stage). */
  getLastProgressAt?: () => number | null;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const elapsed = Math.round(Math.max(0, now - startedAt) / 1000);
  const tokens = getTokens();

  // Seconds since the last unit of progress landed. Only surfaced once it grows
  // past the warn threshold, so a normal fast turn stays clean.
  const lastProgressAt = getLastProgressAt?.() ?? null;
  const idleSec =
    lastProgressAt != null ? Math.round(Math.max(0, now - lastProgressAt) / 1000) : 0;
  const idleColor =
    idleSec >= IDLE_WARN_SEC * 2 ? "#F87171" : idleSec >= IDLE_WARN_SEC ? "#FBBF24" : undefined;

  return (
    <Box paddingX={1}>
      <Text color="#FBBF24" bold>
        {SPINNER[frame % SPINNER.length]}{" "}
      </Text>
      <Text color="#FBBF24">Thinking… </Text>
      <Text dimColor>
        {elapsed}s{tokens > 0 ? ` · ~${humanizeTokens(tokens)} tok` : ""}
      </Text>
      {idleSec >= IDLE_WARN_SEC ? (
        <Text color={idleColor}>{` · idle ${idleSec}s`}</Text>
      ) : null}
      <Text dimColor> · esc to cancel</Text>
    </Box>
  );
}

// ── Status Bar ────────────────────────────────────────────────────────────────

/** Second-line description of the active permission posture. */
function permissionLine(mode: PermissionMode): { label: string; color: string } {
  switch (mode) {
    case "bypass":
      return { label: "bypass permissions on", color: "#FB7185" };
    case "acceptEdits":
      return { label: "auto-accept edits on", color: "#FBBF24" };
    case "readonly":
      return { label: "read-only", color: "#FBBF24" };
    default:
      return { label: "ask before edits", color: theme.cyan };
  }
}

export function StatusLine({
  model,
  branch,
  inputTokens,
  outputTokens,
  cacheHit,
  cacheMiss,
  costUsd,
  pipelineOn,
  verboseOn,
  effort,
  mode = "ask",
  turnOutputTokens = 0,
  turnCostUsd = 0,
}: {
  model: string;
  /** Current git branch (undefined = not a repo / unknown; the chip is hidden). */
  branch?: string;
  inputTokens: number;
  outputTokens: number;
  /** Cumulative prompt tokens served from cache (a "hit"). */
  cacheHit: number;
  /** Cumulative prompt tokens billed fresh (a "miss"). */
  cacheMiss: number;
  /** Cumulative estimated session cost, USD. */
  costUsd: number;
  /** Output tokens accumulated in the CURRENT turn (live; 0 = idle/none). */
  turnOutputTokens?: number;
  /** Estimated cost of the CURRENT turn, USD (live; 0 = idle/none). */
  turnCostUsd?: number;
  /** Whether the eval→enhance→judge pipeline is active (undefined = don't show). */
  pipelineOn?: boolean;
  /** Whether verbose telemetry capture is active (undefined = don't show). */
  verboseOn?: boolean;
  /** Active reasoning effort (undefined = model default; chip hidden). */
  effort?: string;
  /** Current permission posture (drives the second line). */
  mode?: PermissionMode;
}): React.ReactElement {
  const sep = (
    <Text dimColor>{"  │  "}</Text>
  );
  const perm = permissionLine(mode);
  const cost = costUsd > 0 ? `~$${costUsd.toFixed(costUsd < 100 ? 2 : 0)}` : "~$0.00";
  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Line 1 — model · branch · tokens · cache · cost */}
      <Box>
        <Text color={theme.violet} bold>
          {model.split("/").pop()}
        </Text>
        {branch ? (
          <>
            {sep}
            <Text color={theme.cyan}>{branch}</Text>
          </>
        ) : null}
        {sep}
        <Text color={theme.cyan}>↑{humanizeTokens(inputTokens)} </Text>
        <Text color="#34D399">↓{humanizeTokens(outputTokens)}</Text>
        {sep}
        <Text dimColor>cache </Text>
        <Text color="#34D399">{humanizeTokens(cacheHit)}hit</Text>
        <Text dimColor> / </Text>
        <Text color="#FB7185">{humanizeTokens(cacheMiss)}miss</Text>
        {sep}
        <Text color="#FBBF24">{cost}</Text>
        {turnOutputTokens > 0 || turnCostUsd > 0 ? (
          <Text color="#34D399">
            {"  ▲ turn +"}
            {humanizeTokens(turnOutputTokens)}
            {turnCostUsd > 0 ? ` ${formatUsd(turnCostUsd)}` : ""}
          </Text>
        ) : null}
        {effort ? (
          <>
            {sep}
            <Text dimColor>effort:</Text>
            <Text color={theme.violet}>{effort}</Text>
          </>
        ) : null}
        {verboseOn ? (
          <>
            {sep}
            <Text color={theme.cyan}>verbose</Text>
          </>
        ) : null}
        {pipelineOn === true ? (
          <>
            {sep}
            <Text color="#34D399" bold>🏋️ pipeline activated</Text>
          </>
        ) : pipelineOn === false ? (
          <>
            {sep}
            <Text color="#FB7185">bare</Text>
          </>
        ) : null}
      </Box>
      {/* Line 2 — permission posture + cycle hint */}
      <Box>
        <Text color={perm.color} bold>
          {"▶▶ "}
          {perm.label}
        </Text>
        <Text dimColor> (shift+tab to cycle)</Text>
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
