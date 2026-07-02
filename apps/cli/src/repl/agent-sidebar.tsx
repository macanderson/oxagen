/**
 * AgentSidebar — the live right-hand dock that monitors the agent team and the
 * planning agent's task list without disturbing the transcript.
 *
 * Two stacked panels:
 *   • **Agent Team** — every agent working this session, read from the shared
 *     {@link agentRegistry}: the lead turn agent, any dispatched subagents, and
 *     background monitors, each with its live status, model tier, and current step.
 *   • **Task Progress** — the ordered checklist the turn's planning/coordinator
 *     agent is executing, read from the shared {@link taskRegistry}, advancing
 *     from pending → in-progress → done live.
 *
 * It subscribes to both registries' `change` events and ticks once a second so
 * elapsed timers advance while a long step sits running. Visibility is driven by
 * `mode`: "on" pins it open, "off" hides it, "auto" (the default) shows it only
 * while there is something to monitor. It hides itself on a narrow terminal so it
 * never crushes the chat column.
 */
import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { theme } from "../tui/theme.js";
import { tierForSlug, tierLabel } from "../agent/model-router.js";
import {
  agentRegistry,
  type AgentKind,
  type AgentStatus,
  type RunningAgent,
} from "../agent/agent-registry.js";
import { taskRegistry, type TaskStatus, type TrackedTask } from "../agent/task-registry.js";

/** How the sidebar decides whether to show: pinned on, forced off, or automatic. */
export type PanelMode = "auto" | "on" | "off";

/** Fixed panel width — wide enough for a title + status, narrow enough to dock. */
const PANEL_WIDTH = 34;
/**
 * Don't dock the sidebar unless the terminal can spare the room: the panel plus a
 * usable chat column. Below this the sidebar hides itself (in every mode) so a
 * small window keeps the full width for the conversation.
 */
const MIN_TERMINAL_COLS = PANEL_WIDTH + 48;

/** Glyph + color for an agent's run status (matches the `/hud` vocabulary). */
function agentStatusStyle(status: AgentStatus): { glyph: string; color: string } {
  switch (status) {
    case "running":
      return { glyph: "●", color: theme.cyan };
    case "queued":
      return { glyph: "⧗", color: "#FBBF24" };
    case "done":
      return { glyph: "✓", color: "#34D399" };
    case "failed":
      return { glyph: "✗", color: "#F87171" };
  }
}

/** Glyph + color for a task's status — a live checklist. */
function taskStatusStyle(status: TaskStatus): { glyph: string; color: string } {
  switch (status) {
    case "pending":
      return { glyph: "○", color: "gray" };
    case "in_progress":
      return { glyph: "◐", color: theme.cyan };
    case "done":
      return { glyph: "✓", color: "#34D399" };
    case "failed":
      return { glyph: "✗", color: "#F87171" };
  }
}

/** Short label for what kind of agent this is. */
function kindLabel(kind: AgentKind): string {
  return kind;
}

/** Elapsed wall-clock as a compact `1m04s` / `12s`. */
function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

function AgentTeamRow({ agent, now }: { agent: RunningAgent; now: number }): React.ReactElement {
  const { glyph, color } = agentStatusStyle(agent.status);
  const model = agent.model ? tierLabel(tierForSlug(agent.model)) : null;
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text color={theme.violet}>{kindLabel(agent.kind)}</Text>
        <Text wrap="truncate-end">{agent.title}</Text>
      </Box>
      <Box paddingLeft={2} gap={1}>
        <Text dimColor>{elapsed(agent.startedAt, now)}</Text>
        {model ? (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{model}</Text>
          </>
        ) : null}
        {agent.detail ? (
          <>
            <Text dimColor>·</Text>
            <Text dimColor wrap="truncate-end">
              {agent.detail}
            </Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}

function TaskRow({ task }: { task: TrackedTask }): React.ReactElement {
  const { glyph, color } = taskStatusStyle(task.status);
  const strike = task.status === "done";
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text dimColor={strike} wrap="truncate-end">
          {task.title}
        </Text>
      </Box>
      {task.detail && task.status === "in_progress" ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {task.detail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** One bordered, titled panel section. */
function Panel({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={PANEL_WIDTH}
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box>
        <Text color={accent} bold>
          {theme.ring}{" "}
        </Text>
        <Text color={accent} bold>
          {title}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The dock. `nowFn`/`widthFn` are injectable so tests render at a fixed instant
 * and terminal width; production uses the wall clock, a 1s tick, and the live
 * terminal columns.
 */
export function AgentSidebar({
  mode = "auto",
  nowFn,
  widthFn,
}: {
  mode?: PanelMode;
  nowFn?: () => number;
  widthFn?: () => number;
}): React.ReactElement | null {
  const now = nowFn ?? (() => Date.now());
  const width = widthFn ?? (() => process.stdout.columns ?? 80);
  const [, setTick] = useState(0);
  const [agents, setAgents] = useState<RunningAgent[]>(() => agentRegistry.snapshot());
  const [tasks, setTasks] = useState<TrackedTask[]>(() => taskRegistry.snapshot());

  useEffect(() => {
    const refreshAgents = (): void => setAgents(agentRegistry.snapshot());
    const refreshTasks = (): void => setTasks(taskRegistry.snapshot());
    const unsubAgents = agentRegistry.on(refreshAgents);
    const unsubTasks = taskRegistry.on(refreshTasks);
    refreshAgents();
    refreshTasks();
    // Tick so elapsed timers advance while a long step sits running.
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      unsubAgents();
      unsubTasks();
      clearInterval(timer);
    };
  }, []);

  if (mode === "off") return null;
  // A narrow terminal can't spare the columns — never crush the chat.
  if (width() < MIN_TERMINAL_COLS) return null;
  const hasActivity = agents.length > 0 || tasks.length > 0;
  if (mode === "auto" && !hasActivity) return null;

  const at = now();
  const runningAgents = agents.filter((a) => a.status === "running").length;
  const doneTasks = tasks.filter((t) => t.status === "done").length;

  return (
    <Box flexDirection="column" marginLeft={1} flexShrink={0} gap={1}>
      <Panel title="Agent Team" accent={theme.cyan}>
        <Box marginBottom={1}>
          <Text dimColor>
            {runningAgents} running · {agents.length} total
          </Text>
        </Box>
        {agents.length === 0 ? (
          <Text dimColor>No agents yet.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {agents.map((a) => (
              <AgentTeamRow key={a.id} agent={a} now={at} />
            ))}
          </Box>
        )}
      </Panel>

      <Panel title="Task Progress" accent={theme.violet}>
        <Box marginBottom={1}>
          <Text dimColor>
            {doneTasks}/{tasks.length} done
          </Text>
        </Box>
        {tasks.length === 0 ? (
          <Text dimColor>No plan yet.</Text>
        ) : (
          <Box flexDirection="column">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </Box>
        )}
      </Panel>
    </Box>
  );
}
