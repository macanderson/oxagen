/**
 * swarm-panel.tsx — the Ctrl+S "agent swarm view".
 *
 * A takeover panel (same shape as files-panel / tasks-panel) listing every live
 * agent read from the shared {@link agentRegistry}: the lead turn agent, any
 * dispatched subagents, and background fleet pollers — each with its status
 * glyph, kind, title, model tier, cumulative tokens/cost when tracked, and its
 * current activity. ↑/↓ move the selection (wrapping), Enter/→ drills into one
 * agent's detail, Esc steps back out of the detail — or closes from the list.
 *
 * Ctrl+X on the highlighted row is a DOUBLE-PRESS kill: the first press arms
 * (with a hint), a second press — with no other key in between — calls the
 * injected `onKill(id)`. Any other key disarms. The arm/disarm decision lives in
 * the pure {@link resolveCtrlX} helper so it is unit-testable directly. The kill
 * itself is delegated entirely to the `onKill` prop (default: a no-op returning
 * false) so this panel never has to know how the roster is mutated — no build
 * coupling to a registry `kill` method landing in parallel.
 */
import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { theme } from "../tui/theme.js";
import { tierForSlug, tierLabel } from "../agent/model-router.js";
import {
  agentRegistry,
  type AgentStatus,
  type RunningAgent,
} from "../agent/agent-registry.js";
import { formatElapsed } from "./tasks-panel.js";
import { visibleWindow } from "./slash-menu.js";

/** Max agent rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_AGENTS = 12;

/** How often (ms) the panel re-reads the snapshot so timers/statuses stay live. */
export const SWARM_POLL_MS = 500;

/** Default snapshot source — the process-wide agent registry. Module-level so it
 *  is referentially stable (an inline default would re-fire the poll effect). */
const defaultAgentSnapshot = (): RunningAgent[] => agentRegistry.snapshot();

/** No kill handle wired: report failure so the panel says so rather than lying. */
const noKill = (): boolean => false;

/** Glyph + color for an agent's run status (matches the `/hud` vocabulary). */
export function agentStatusStyle(status: AgentStatus): {
  glyph: string;
  color: string;
} {
  switch (status) {
    case "running":
      return { glyph: "●", color: theme.cyan };
    case "queued":
      return { glyph: "⧗", color: theme.amber };
    case "done":
      return { glyph: "✓", color: theme.green };
    case "failed":
      return { glyph: "✗", color: theme.red };
    case "killed":
      // ◼ (stop square) + red = a deliberate user kill, distinct from ✗ failed —
      // matches the canonical convention in tui/activity.ts + agent-sidebar.tsx.
      return { glyph: "◼", color: theme.red };
  }
}

/**
 * The pure double-press decision for the Ctrl+X kill: a press ARMS the currently
 * highlighted row, and a second press KILLS only when the same row is still
 * armed (no intervening key moved the selection or cleared the arm). Mirrors
 * files-panel's `resolveCtrlO`, but keyed on the row id rather than a time
 * window — "any other key disarms" is the safety, not a timeout.
 */
export function resolveCtrlX(
  armedId: string | null,
  selectedId: string,
): "arm" | "kill" {
  return armedId !== null && armedId === selectedId ? "kill" : "arm";
}

/** Compact token count, e.g. `840 tok` / `1.2k tok`. */
function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  return `${(n / 1000).toFixed(1)}k tok`;
}

export interface SwarmPanelProps {
  /** False while another surface owns the keyboard; the panel ignores keys. */
  active?: boolean;
  onClose: () => void;
  width?: number;
  /** Test seam: source of the agent list (defaults to the registry singleton). */
  snapshot?: () => RunningAgent[];
  /** Remove/abort an agent by id. Returns whether a real kill happened. */
  onKill?: (id: string) => boolean;
  /** Test seam: clock for elapsed timers. */
  now?: () => number;
  /** Test seam: how often to re-read the snapshot. */
  pollMs?: number;
}

export function SwarmPanel({
  active = true,
  onClose,
  width = 84,
  snapshot = defaultAgentSnapshot,
  onKill = noKill,
  now = Date.now,
  pollMs = SWARM_POLL_MS,
}: SwarmPanelProps): React.ReactElement {
  const [agents, setAgents] = useState<RunningAgent[]>(() => snapshot());
  const [selected, setSelected] = useState(0);
  const [drilled, setDrilled] = useState(false);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Stay live: re-read the snapshot on a short interval so a running agent's
  // elapsed timer advances and status transitions / new workers surface.
  useEffect(() => {
    const refresh = (): void => {
      if (mountedRef.current) setAgents(snapshot());
    };
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [snapshot, pollMs]);

  const clampedSelected = Math.min(selected, Math.max(0, agents.length - 1));
  const current = agents[clampedSelected];
  const runningCount = agents.filter((a) => a.status === "running").length;

  const disarm = useCallback((): void => {
    setArmedId(null);
  }, []);

  useInput(
    (input, key) => {
      if (drilled) {
        if (key.escape || key.leftArrow) setDrilled(false);
        return;
      }
      if (key.ctrl && input === "x") {
        const row = agents[clampedSelected];
        if (!row) return;
        if (resolveCtrlX(armedId, row.id) === "kill") {
          const killed = onKill(row.id);
          setNotice(
            killed
              ? `killed ${row.title}`
              : `no kill handle — dismissed ${row.title}`,
          );
          setArmedId(null);
        } else {
          setArmedId(row.id);
          setNotice(null);
        }
        return;
      }
      // Any other key breaks the double-press chain.
      disarm();

      if (key.escape) {
        onClose();
        return;
      }
      if (agents.length === 0) return;
      if (key.upArrow) {
        setSelected((clampedSelected - 1 + agents.length) % agents.length);
        return;
      }
      if (key.downArrow) {
        setSelected((clampedSelected + 1) % agents.length);
        return;
      }
      if (key.return || key.rightArrow) {
        setDrilled(true);
      }
    },
    { isActive: active },
  );

  const innerWidth = Math.max(width - 4, 20);
  const at = now();

  // Detail view — the highlighted agent expanded.
  if (drilled && current) {
    const { glyph, color } = agentStatusStyle(current.status);
    const model = current.model ? tierLabel(tierForSlug(current.model)) : null;
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.cyan}
        paddingX={1}
        width={width}
      >
        <Box gap={1}>
          <Text color={color} bold>
            {glyph}
          </Text>
          <Text color={theme.violet}>{current.kind}</Text>
          <Text bold wrap="truncate-end">
            {current.title}
          </Text>
        </Box>
        <Box marginTop={1} paddingLeft={2} flexDirection="column">
          <Box gap={1}>
            <Text dimColor>status</Text>
            <Text color={color}>{current.status}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>{formatElapsed(at - current.startedAt)}</Text>
          </Box>
          {model ? (
            <Box gap={1}>
              <Text dimColor>model</Text>
              <Text>{model}</Text>
            </Box>
          ) : null}
          {current.outputTokens !== undefined ||
          current.costUsd !== undefined ? (
            <Box gap={1}>
              <Text dimColor>usage</Text>
              {current.outputTokens !== undefined ? (
                <Text>{formatTokens(current.outputTokens)}</Text>
              ) : null}
              {current.costUsd !== undefined ? (
                <Text color={theme.green}>${current.costUsd.toFixed(2)}</Text>
              ) : null}
            </Box>
          ) : null}
          {current.detail ? (
            <Box gap={1} width={innerWidth}>
              <Text dimColor>doing</Text>
              <Text wrap="truncate-end">{current.detail}</Text>
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>esc/← back to the swarm</Text>
        </Box>
      </Box>
    );
  }

  const { start, end } = visibleWindow(
    agents.length,
    clampedSelected,
    MAX_VISIBLE_AGENTS,
  );
  const visible = agents.slice(start, end);
  const armedRow =
    armedId !== null && current && armedId === current.id ? current : null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.cyan}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={theme.cyan} bold>
          {"Agent Swarm "}
        </Text>
        <Text dimColor>
          · {runningCount} running · {agents.length} total
        </Text>
      </Box>

      {agents.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No agents yet — the turn agent and any dispatched workers will
            appear here as they run.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((agent, i) => {
            const idx = start + i;
            const isSelected = idx === clampedSelected;
            const { glyph, color } = agentStatusStyle(agent.status);
            const model = agent.model
              ? tierLabel(tierForSlug(agent.model))
              : null;
            return (
              <Box key={agent.id} width={innerWidth}>
                <Text
                  color={isSelected ? theme.cyan : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={2}>
                  <Text color={color} bold>
                    {glyph}
                  </Text>
                </Box>
                <Box width={9}>
                  <Text
                    color={theme.violet}
                    dimColor={!isSelected}
                    wrap="truncate-end"
                  >
                    {agent.kind}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    color={isSelected ? theme.cyan : undefined}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    {agent.title}
                  </Text>
                </Box>
                {model ? (
                  <Box marginLeft={1}>
                    <Text dimColor>{model}</Text>
                  </Box>
                ) : null}
                {agent.outputTokens !== undefined ? (
                  <Box marginLeft={1}>
                    <Text dimColor>{formatTokens(agent.outputTokens)}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      {armedRow ? (
        <Box marginTop={1}>
          <Text color={theme.amber} wrap="truncate-end">
            ctrl+x again to kill {armedRow.title}
          </Text>
        </Box>
      ) : notice ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {notice}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {agents.length > MAX_VISIBLE_AGENTS
            ? `${clampedSelected + 1}/${agents.length} · `
            : ""}
          ↑↓ navigate · ↵/→ detail · ctrl+x ctrl+x kill · esc close
        </Text>
      </Box>
    </Box>
  );
}
