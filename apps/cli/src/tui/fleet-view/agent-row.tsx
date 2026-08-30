/**
 * Agent Row — one line of the fleet roster for a single working subagent.
 *
 * Renders a live status glyph (an animated braille spinner while the agent is
 * working; a check / cross / dot once it settles), the task title, its model-tier
 * badge, step count, last tool, and the agent's own token + cost accounting.
 * Running rows are coloured to pop out of the roster so the eye tracks live work.
 *
 * Purely presentational: it takes an {@link AgentSnapshot} plus the shared
 * animation frame and renders — no engine imports, no side effects.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { activityGlyph } from "../activity.js";
import { tierLabel, formatUsd } from "../../agent/model-router.js";
import { humanizeTokens } from "../../repl/components.js";
import type {
  AgentSnapshot,
  ModelTier,
  TaskStatus,
} from "../../agent/fleet/types.js";

// Column widths, shared with {@link RosterHeader} so headings line up with cells.
const W = {
  glyph: 2,
  title: 34,
  tier: 8,
  steps: 7,
  tool: 18,
  tokens: 9,
  cost: 10,
} as const;

/** Brand colour for a tier badge: fast=green, balanced=cyan, precise=violet. */
function tierColor(tier: ModelTier): string {
  return tier === "fast"
    ? "#34D399"
    : tier === "balanced"
      ? theme.cyan
      : theme.violet;
}

/**
 * Status glyph + colour, via the shared {@link activityGlyph} vocabulary
 * (`TaskStatus` is a literal subset of `ActivityStatus`) — running animates
 * through the shared frame counter, matching the HUD and best-of-N lanes.
 */
function glyphFor(
  status: TaskStatus,
  frame: number,
): { ch: string; color: string } {
  const { glyph, color } = activityGlyph(status, frame);
  return { ch: glyph, color };
}

/** Whole-seconds elapsed for a running / finished agent. */
function elapsed(a: AgentSnapshot): string {
  if (!a.startedAt) return "";
  const end = a.finishedAt ?? Date.now();
  return `${Math.max(0, Math.round((end - a.startedAt) / 1000))}s`;
}

/** Column-heading row, kept beside the cell widths so the two never drift. */
export function RosterHeader(): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Box width={W.glyph} />
      <Box width={W.title}>
        <Text dimColor>TASK</Text>
      </Box>
      <Box width={W.tier}>
        <Text dimColor>MODEL</Text>
      </Box>
      <Box width={W.steps}>
        <Text dimColor>STEPS</Text>
      </Box>
      <Box width={W.tool}>
        <Text dimColor>ACTIVITY</Text>
      </Box>
      <Box width={W.tokens} justifyContent="flex-end">
        <Text dimColor>TOKENS</Text>
      </Box>
      <Box width={W.cost} justifyContent="flex-end">
        <Text dimColor>COST</Text>
      </Box>
    </Box>
  );
}

export function AgentRow({
  agent,
  frame,
  showDetail,
}: {
  agent: AgentSnapshot;
  frame: number;
  showDetail: boolean;
}): React.ReactElement {
  const running = agent.status === "running";
  const dim = agent.status === "queued" || agent.status === "cancelled";
  const { ch, color } = glyphFor(agent.status, frame);
  const tokens = agent.usage.inputTokens + agent.usage.outputTokens;
  const tool =
    agent.lastTool ??
    (running ? "thinking…" : agent.status === "queued" ? "waiting" : "—");

  // The detail line: the streamed log tail while running, the error once failed.
  const detail =
    agent.status === "failed" && agent.error
      ? agent.error
      : agent.logTail.replace(/\s+/g, " ").trim();

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Box width={W.glyph}>
          <Text color={color} bold>
            {ch}
          </Text>
        </Box>
        <Box width={W.title}>
          <Text
            color={running ? "white" : undefined}
            bold={running}
            dimColor={dim}
            wrap="truncate"
          >
            {agent.title}
          </Text>
        </Box>
        <Box width={W.tier}>
          <Text color={tierColor(agent.tier)}>{tierLabel(agent.tier)}</Text>
        </Box>
        <Box width={W.steps}>
          <Text dimColor>{agent.steps > 0 ? `${agent.steps}⋯` : "—"}</Text>
        </Box>
        <Box width={W.tool}>
          <Text color={running ? "#FBBF24" : theme.dim} wrap="truncate">
            {tool}
          </Text>
        </Box>
        <Box width={W.tokens} justifyContent="flex-end">
          <Text dimColor>{tokens > 0 ? humanizeTokens(tokens) : "—"}</Text>
        </Box>
        <Box width={W.cost} justifyContent="flex-end">
          <Text color={agent.usage.costUsd > 0 ? "#34D399" : theme.dim}>
            {agent.usage.costUsd > 0 ? formatUsd(agent.usage.costUsd) : "—"}
          </Text>
        </Box>
      </Box>

      {showDetail && detail ? (
        <Box paddingX={1} marginLeft={2}>
          <Text dimColor wrap="truncate">
            {running ? `${elapsed(agent)} · ` : ""}
            {agent.status === "failed" ? "✗ " : "↳ "}
            {detail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
