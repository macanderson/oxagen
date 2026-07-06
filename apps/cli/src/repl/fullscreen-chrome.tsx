/**
 * Presentational chrome for the REPL's full-screen TUI mode: the header bar,
 * the bounded/scrollable transcript viewport, and the live-stats panel dock.
 *
 * Kept as pure, focused, prop-driven components (same philosophy as
 * components.tsx) so each renders and unit-tests in isolation under
 * ink-testing-library without needing a real TTY, the agent loop, or any of
 * interactive.tsx's stateful wiring — interactive.tsx composes these directly
 * in its full-screen render branch, passing in its own state as props.
 */
import { Box, Text } from "ink";
import React, { useMemo } from "react";
import { theme } from "../tui/theme.js";
import { formatUsd } from "../agent/model-router.js";
import { MessageView, humanizeTokens, type Message } from "./components.js";
import type { DiffTheme } from "../tui/terminal-theme.js";
import type { SessionMetrics } from "../agent/metrics.js";
import type { TelemetryState } from "./telemetry.js";
import { ENGINE_DEFAULT_MAX_STEPS, TRACKED_TOOLS } from "./telemetry.js";
import type { RepoInfo } from "./use-repo-info.js";
import { abbreviatePath } from "./git-info.js";
import {
  estimateMessageRows,
  computeVisibleWindow,
  effectiveOffset,
  maxOffsetFor,
  type ScrollState,
} from "./scroll.js";
import { DOCK_PANEL_HEIGHT } from "./mouse-select.js";

// Extra accent tones not already named in tui/theme.ts's palette, kept local
// since they're used only by this dashboard chrome.
const AMBER = "#FBBF24";
const GREEN = "#34D399";

/** `HH:MM:SS`, 24h, zero-padded — locale-independent so the header clock never
 *  reflows width or switches to AM/PM depending on the user's system locale. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Compact elapsed duration: `12s` under a minute, `1m04s` at/above. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
}

// ── Header bar ──────────────────────────────────────────────────────────────

export function HeaderBar({
  model,
  branch,
  sessionLabel,
  sessionCostUsd,
  now,
  version,
  scope,
}: {
  model: string;
  branch?: string;
  /** Short label for what this session is working on (falls back to the cwd's folder name). */
  sessionLabel: string;
  sessionCostUsd: number;
  now: number;
  /** CLI build number, shown right after the brand mark (e.g. "0.10.0"). */
  version?: string;
  /** Connected org/workspace scope, e.g. "acme/prod". */
  scope?: string;
}): React.ReactElement {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        <Text color={AMBER} bold>
          {"◇ OXAGEN"}
        </Text>
        {version ? <Text dimColor>{`v${version}`}</Text> : null}
        {scope ? (
          <>
            <Text dimColor>·</Text>
            <Text color={theme.cyan}>{scope}</Text>
          </>
        ) : null}
        <Text dimColor>·</Text>
        <Text wrap="truncate-end">{sessionLabel}</Text>
        {branch ? (
          <>
            <Text dimColor>·</Text>
            <Text color={theme.cyan}>{branch}</Text>
          </>
        ) : null}
      </Box>
      <Box gap={1}>
        <Text color={theme.violet} bold>
          {model.split("/").pop()}
        </Text>
        <Text dimColor>·</Text>
        <Text dimColor>{formatClock(now)}</Text>
        <Text dimColor>·</Text>
        <Text color={GREEN}>{formatUsd(sessionCostUsd)}</Text>
      </Box>
    </Box>
  );
}

// ── Transcript viewport ──────────────────────────────────────────────────────

export function TranscriptViewport({
  committedMessages,
  liveMessage,
  diffTheme,
  width,
  height,
  scroll,
}: {
  committedMessages: readonly Message[];
  liveMessage?: Message;
  diffTheme?: DiffTheme;
  width: number;
  /** Total bounded height, in rows, INCLUDING the "N lines above" indicator slot. */
  height: number;
  scroll: ScrollState;
}): React.ReactElement {
  const all: readonly Message[] = liveMessage
    ? [...committedMessages, liveMessage]
    : committedMessages;

  // Row height per COMMITTED message, recomputed only when the committed
  // transcript (identity — see interactive.tsx's own memoized
  // `committedMessages`) or `width` actually changes. This used to re-measure
  // the ENTIRE transcript, including scrollback long off-screen, on every
  // render of this component — including the 1Hz clock tick and every
  // streamed token of the live message, neither of which touches anything
  // BUT that live message. The live message's own height is cheap (a single
  // message) and computed fresh below.
  const committedRowHeights = useMemo(
    () => committedMessages.map((m) => estimateMessageRows(m, width)),
    [committedMessages, width],
  );
  const rowHeights = liveMessage
    ? [...committedRowHeights, estimateMessageRows(liveMessage, width)]
    : committedRowHeights;

  // One row is always reserved for the indicator slot (shown as an amber hint
  // when scrolled up, an empty spacer at the bottom) so the message area's
  // height never changes as the user scrolls — no 1-row reflow jump at the
  // boundary between "scrolled up" and "at bottom".
  const contentHeight = Math.max(1, height - 1);
  const totalLines = rowHeights.reduce((a, b) => a + b, 0);
  const ctx = { totalLines, viewportHeight: contentHeight };
  const offset = effectiveOffset(scroll, ctx);
  const atBottom = offset >= maxOffsetFor(ctx);
  const { startIndex, endIndex, hiddenAbove } = computeVisibleWindow(rowHeights, offset, contentHeight);
  const visible = all.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box>
        {atBottom ? (
          <Text> </Text>
        ) : (
          <>
            <Text color={AMBER} bold>
              {"▲ "}
              {hiddenAbove}
              {" lines above"}
            </Text>
            <Text dimColor>{" · End to jump"}</Text>
          </>
        )}
      </Box>
      <Box flexDirection="column" height={contentHeight} overflow="hidden">
        {visible.map((msg, i) => (
          <MessageView key={startIndex + i} msg={msg} diffTheme={diffTheme} />
        ))}
      </Box>
    </Box>
  );
}

// ── Live-stats panel dock ─────────────────────────────────────────────────────

/** One bordered, captioned panel — the dock's shared shape (mirrors agent-sidebar.tsx's private Panel). */
function DockPanel({
  title,
  accent,
  width,
  children,
}: {
  title: string;
  accent: string;
  width: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={DOCK_PANEL_HEIGHT}
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Text color={accent} bold>
        {title}
      </Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

/** Right-pads a label so the panel's value column lines up. */
function label(text: string, width: number): string {
  return text.padEnd(width);
}

/** REPO panel's PR row: "…" while the async gh lookup is still in flight, "no PR" once it resolves to none. */
function prLabel(prNumber: number | null | undefined): string {
  if (prNumber === undefined) return "…";
  if (prNumber === null) return "no PR";
  return `#${prNumber}`;
}

const PHASE_TITLE: Record<string, string> = {
  idle: "idle",
  evaluate: "evaluate",
  plan: "plan",
  enhance: "enhance",
  route: "route",
  execute: "execute",
  judge: "judge",
  revise: "revise",
  complete: "complete",
};

/** How many panels wide the dock is — kept as one constant so the width math and the JSX below can't drift apart. */
const DOCK_PANEL_COUNT = 5;

/** Column gap between dock panels. */
const DOCK_PANEL_GAP = 1;

/**
 * Width of one dock panel such that all DOCK_PANEL_COUNT panels + gaps always
 * fit inside `cols`. This must never round up past the terminal width: the
 * dock row has no shrink slack, so an overflowing row is clipped at the screen
 * edge and the right-most panel loses its right border (regression when the
 * dock grew 4 → 5 panels with a 16-col floor: 5×16+4 = 84 > an 80-col
 * terminal). The floor of 4 only keeps the Box border-capable on absurdly
 * narrow screens; content readability is already gone well above that.
 */
export function dockPanelWidth(cols: number): number {
  return Math.max(
    4,
    Math.floor((cols - DOCK_PANEL_GAP * (DOCK_PANEL_COUNT - 1)) / DOCK_PANEL_COUNT),
  );
}

export function TelemetryDock({
  telemetry,
  metrics,
  cacheHit,
  isStreaming,
  now,
  cols,
  repo,
}: {
  telemetry: TelemetryState;
  metrics: SessionMetrics;
  /** Cumulative prompt tokens served from cache (mirrors StatusLine's own cacheHit). */
  cacheHit: number;
  isStreaming: boolean;
  now: number;
  cols: number;
  repo: RepoInfo;
}): React.ReactElement {
  const gap = DOCK_PANEL_GAP;
  const panelWidth = dockPanelWidth(cols);

  const { models, turn, tools } = telemetry;
  const elapsedMs = turn.turnStartedAt != null ? now - turn.turnStartedAt : 0;
  const elapsedSec = Math.max(1, elapsedMs / 1000);
  // Include the in-flight stream's live estimate so tok/s moves DURING a call
  // instead of reading 0 until the first usage settles (see metrics.ts).
  const liveTokensOut = metrics.turnTokensOut + metrics.streamTokensOut;
  const tokPerSec = isStreaming ? Math.round(liveTokensOut / elapsedSec) : 0;

  const toolCell = (name: string): string => `${name} ${tools[name] ?? 0}`;

  return (
    <Box flexDirection="row" gap={gap}>
      <DockPanel title="MODELS" accent={theme.violet} width={panelWidth}>
        <Text wrap="truncate-end">
          {label("planner", 8)}
          <Text dimColor>{models.planner ?? "—"}</Text>
        </Text>
        <Text wrap="truncate-end">
          {label("worker", 8)}
          <Text dimColor>{models.worker ?? "—"}</Text>
        </Text>
        <Text wrap="truncate-end">
          {label("judge", 8)}
          <Text dimColor>{models.judge ?? "—"}</Text>
        </Text>
      </DockPanel>

      <DockPanel title="TURN" accent={theme.cyan} width={panelWidth}>
        <Text wrap="truncate-end">
          {label("phase", 7)}
          <Text color={theme.cyan}>{PHASE_TITLE[turn.phase] ?? turn.phase}</Text>
        </Text>
        <Text wrap="truncate-end">
          {label("step", 7)}
          <Text dimColor>
            {turn.step}/{turn.maxStep ?? ENGINE_DEFAULT_MAX_STEPS}
          </Text>
        </Text>
        <Text wrap="truncate-end">
          {label("round", 7)}
          <Text dimColor>
            {turn.reviseRound} · {turn.turnStartedAt != null ? formatElapsed(elapsedMs) : "—"}
          </Text>
        </Text>
      </DockPanel>

      <DockPanel title="TOKENS" accent={AMBER} width={panelWidth}>
        <Text wrap="truncate-end">
          <Text color={theme.cyan}>{"↑"}{humanizeTokens(metrics.sessionTokensIn)}</Text>
          {"  "}
          <Text color={GREEN}>{"↓"}{humanizeTokens(metrics.sessionTokensOut + metrics.streamTokensOut)}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>cache </Text>
          <Text color={GREEN}>{humanizeTokens(cacheHit)}hit</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={AMBER}>{formatUsd(metrics.sessionCostUsd)}</Text>
          <Text dimColor> · {tokPerSec}tok/s</Text>
        </Text>
      </DockPanel>

      <DockPanel title="TOOLS" accent={GREEN} width={panelWidth}>
        <Text wrap="truncate-end" dimColor>
          {toolCell(TRACKED_TOOLS[0])}  {toolCell(TRACKED_TOOLS[1])}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {toolCell(TRACKED_TOOLS[2])}  {toolCell(TRACKED_TOOLS[3])}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {toolCell(TRACKED_TOOLS[4])}  {toolCell(TRACKED_TOOLS[5])}
        </Text>
      </DockPanel>

      <DockPanel title="REPO" accent="#F472B6" width={panelWidth}>
        <Text wrap="truncate-end" dimColor>
          {abbreviatePath(repo.root, Math.max(6, panelWidth - 4))}
        </Text>
        <Text wrap="truncate-end">
          <Text color={theme.cyan}>{repo.branch ?? "—"}</Text>
        </Text>
        <Text wrap="truncate-end" dimColor>
          {prLabel(repo.prNumber)}
        </Text>
      </DockPanel>
    </Box>
  );
}
