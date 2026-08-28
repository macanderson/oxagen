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
import { sunsetColorAt } from "../tui/banner.js";
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
  computeBottomWindow,
  effectiveOffset,
  maxOffsetFor,
  type ScrollState,
} from "./scroll.js";
import { DOCK_PANEL_HEIGHT } from "./mouse-select.js";

// Extra accent tones not already named in tui/theme.ts's palette, kept local
// since they're used only by this dashboard chrome.
const AMBER = "#FBBF24";
const GREEN = "#34D399";

// `HH:MM:SS`, 24h, zero-padded — the single shared implementation lives in
// mission-control/lib.ts; imported for the header clock and re-exported for
// this file's existing test/consumers.
import { formatClock } from "../tui/mission-control/lib.js";
export { formatClock };

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
  dispatchMode = false,
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
  /** When true, show the async Dispatch-mode indicator (`⇉ dispatch`). */
  dispatchMode?: boolean;
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
        {dispatchMode ? (
          <>
            <Text color={theme.violet} bold>
              {"⇉ dispatch"}
            </Text>
            <Text dimColor>·</Text>
          </>
        ) : null}
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
  // `committedMessages`) or `width` actually changes. Re-measuring the ENTIRE
  // transcript, including scrollback long off-screen, on every render of this
  // component would waste work on the 1Hz clock tick and every streamed token
  // of the live message, neither of which touches anything BUT that live
  // message. The live message's own height is cheap (a single
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

  // Two render strategies (see scroll.ts):
  //  · Pinned to the bottom (the default, and wherever sticky-bottom is
  //    engaged): anchor the transcript's TAIL to the viewport's bottom edge
  //    with flex-end, so the newest output is always fully visible at REAL
  //    rendered heights — height-estimate drift can't cut it off. While the
  //    transcript is still shorter than the viewport, render top-down instead
  //    (anchorBottom false), like any fresh session.
  //  · Scrolled up: window the messages around the offset and slide the first
  //    one partially off the top via negative marginTop (clipTop) — Ink clips
  //    both edges of an overflow-hidden Box, so scrolling is line-exact even
  //    through a message taller than the whole viewport.
  const bottomWindow = computeBottomWindow(rowHeights, contentHeight);
  const scrolledWindow = computeVisibleWindow(
    rowHeights,
    offset,
    contentHeight,
  );
  const hiddenRows = scrolledWindow.hiddenAbove + scrolledWindow.clipTop;
  const visible = atBottom
    ? all.slice(bottomWindow.startIndex)
    : all.slice(scrolledWindow.startIndex, scrolledWindow.endIndex);
  const firstVisibleIndex = atBottom
    ? bottomWindow.startIndex
    : scrolledWindow.startIndex;

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box>
        {atBottom ? (
          <Text> </Text>
        ) : (
          <>
            <Text color={AMBER} bold>
              {"▲ "}
              {hiddenRows}
              {" lines above"}
            </Text>
            <Text dimColor>{" · End to jump"}</Text>
          </>
        )}
      </Box>
      <Box
        flexDirection="column"
        height={contentHeight}
        overflow="hidden"
        justifyContent={
          atBottom && bottomWindow.anchorBottom ? "flex-end" : "flex-start"
        }
      >
        <Box
          flexDirection="column"
          flexShrink={0}
          marginTop={atBottom ? 0 : -scrolledWindow.clipTop}
        >
          {visible.map((msg, i) => (
            <MessageView
              key={firstVisibleIndex + i}
              msg={msg}
              diffTheme={diffTheme}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// ── Live-stats panel dock ─────────────────────────────────────────────────────

/**
 * Split a string into runs of same-colored characters along the app's sunset
 * gradient (the SAME amber→burnt-red sweep the OXAGEN banner uses), mapping
 * character `i` of the whole dock row to its horizontal position `t ∈ [0,1]`.
 * `spanStart`/`spanEnd` locate this fragment within the full row so a panel's
 * title continues the gradient exactly where the previous panel left off,
 * rather than restarting per-panel — the five panels read as one sweep.
 */
function gradientTextRuns(
  text: string,
  spanStart: number,
  spanEnd: number,
): Array<{ text: string; color: string }> {
  const runs: Array<{ text: string; color: string }> = [];
  const len = text.length;
  let run = "";
  let color = "";
  for (let i = 0; i < len; i++) {
    const local = len <= 1 ? 0 : i / (len - 1);
    const c = sunsetColorAt(spanStart + (spanEnd - spanStart) * local);
    if (c === color) {
      run += text[i];
    } else {
      if (run) runs.push({ text: run, color });
      run = text[i] ?? "";
      color = c;
    }
  }
  if (run) runs.push({ text: run, color });
  return runs;
}

/**
 * One bordered, captioned panel — the dock's shared shape (mirrors
 * agent-sidebar.tsx's private Panel). Its caption and border are painted with
 * the OXAGEN sunset gradient: `gradientStart`/`gradientEnd` are the panel's
 * `t ∈ [0,1]` position within the full dock row, so all panels together sweep
 * the identical amber→burnt-red gradient as the ASCII banner.
 */
function DockPanel({
  title,
  gradientStart,
  gradientEnd,
  width,
  children,
}: {
  title: string;
  gradientStart: number;
  gradientEnd: number;
  width: number;
  children: React.ReactNode;
}): React.ReactElement {
  // Border tone = the gradient color at the panel's midpoint, so each box's
  // frame sits at its own point along the same sweep the titles trace.
  const borderColor = sunsetColorAt((gradientStart + gradientEnd) / 2);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={DOCK_PANEL_HEIGHT}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold>
        {gradientTextRuns(title, gradientStart, gradientEnd).map((run, i) => (
          <Text key={i} color={run.color} bold>
            {run.text}
          </Text>
        ))}
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
    Math.floor(
      (cols - DOCK_PANEL_GAP * (DOCK_PANEL_COUNT - 1)) / DOCK_PANEL_COUNT,
    ),
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

  // Each panel owns one equal slice of the [0,1] gradient axis, in left→right
  // order, so the five panels' captions + borders together sweep the exact
  // amber→burnt-red sunset gradient the OXAGEN banner uses. Kept as a helper so
  // adding/removing a panel only requires updating DOCK_PANEL_COUNT.
  const span = (
    index: number,
  ): { gradientStart: number; gradientEnd: number } => ({
    gradientStart: index / DOCK_PANEL_COUNT,
    gradientEnd: (index + 1) / DOCK_PANEL_COUNT,
  });

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
      <DockPanel title="MODELS" {...span(0)} width={panelWidth}>
        <Text wrap="truncate-end">
          {label("triage", 8)}
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

      <DockPanel title="TURN" {...span(1)} width={panelWidth}>
        <Text wrap="truncate-end">
          {label("phase", 7)}
          <Text color={theme.cyan}>
            {PHASE_TITLE[turn.phase] ?? turn.phase}
          </Text>
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
            {turn.reviseRound} ·{" "}
            {turn.turnStartedAt != null ? formatElapsed(elapsedMs) : "—"}
          </Text>
        </Text>
      </DockPanel>

      <DockPanel title="TOKENS" {...span(2)} width={panelWidth}>
        <Text wrap="truncate-end">
          <Text color={theme.cyan}>
            {"↑"}
            {humanizeTokens(metrics.sessionTokensIn)}
          </Text>
          {"  "}
          <Text color={GREEN}>
            {"↓"}
            {humanizeTokens(metrics.sessionTokensOut + metrics.streamTokensOut)}
          </Text>
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

      <DockPanel title="TOOLS" {...span(3)} width={panelWidth}>
        <Text wrap="truncate-end" dimColor>
          {toolCell(TRACKED_TOOLS[0])} {toolCell(TRACKED_TOOLS[1])}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {toolCell(TRACKED_TOOLS[2])} {toolCell(TRACKED_TOOLS[3])}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {toolCell(TRACKED_TOOLS[4])} {toolCell(TRACKED_TOOLS[5])}
        </Text>
      </DockPanel>

      <DockPanel title="REPO" {...span(4)} width={panelWidth}>
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
