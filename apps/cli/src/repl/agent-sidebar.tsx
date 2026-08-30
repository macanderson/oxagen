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
import {
  taskRegistry,
  type TaskStatus,
  type TrackedTask,
} from "../agent/task-registry.js";

/** How the sidebar decides whether to show: pinned on, forced off, or automatic. */
export type PanelMode = "auto" | "on" | "off";

/**
 * One navigable side-panel row: which list it lives in (`zone`) and the registry
 * id of the row (`id`).
 */
export type PanelTarget = { zone: "agent" | "task"; id: string };

/**
 * The panel focus, as tracked by the REPL's focus model — a highlighted row, or
 * `null` (equivalently a `zone: "input"` focus) meaning the input bar owns focus.
 */
export type PanelFocus = PanelTarget | null;

/** Fixed panel width — wide enough for a title + status, narrow enough to dock. */
const PANEL_WIDTH = 34;
/**
 * Don't dock the sidebar unless the terminal can spare the room: the panel plus a
 * usable chat column. Below this the sidebar hides itself (in every mode) so a
 * small window keeps the full width for the conversation.
 */
const MIN_TERMINAL_COLS = PANEL_WIDTH + 48;

/**
 * Exported so the REPL can refuse to move focus into a panel that isn't docked
 * (a narrow terminal hides it) — navigating into an invisible list would strand
 * the highlight off-screen.
 */
export const SIDEBAR_MIN_COLS = MIN_TERMINAL_COLS;

/**
 * Whether the dock has genuine FLEET activity worth showing — the single source
 * of truth shared by the sidebar's own `auto` visibility gate AND the REPL's
 * "can Down enter the dock?" check, so the two never disagree (a Down that
 * entered an auto-hidden dock would strand the highlight on an invisible row).
 *
 * A plain single-agent, single-task turn registers exactly one `kind: "turn"`
 * lead agent and one task — that is NOT fleet activity and stays hidden. The
 * dock reveals only when work fans out: a multi-task plan, or ANY delegated
 * worker (a dispatched subagent / fleet / monitor — anything that isn't the
 * lead turn agent).
 */
export function hasFleetActivity(
  agents: RunningAgent[],
  tasks: TrackedTask[],
): boolean {
  const workerAgents = agents.filter((a) => a.kind !== "turn").length;
  return tasks.length > 1 || workerAgents > 0;
}

/**
 * The flat, ordered list of navigable panel items — every Agent Team row (in
 * roster order) followed by every Task Progress row (in plan order). This is the
 * single source of truth for arrow-key traversal: the REPL walks this list so
 * the visual order and the navigation order can never drift apart.
 */
export function panelNavTargets(
  agents: RunningAgent[],
  tasks: TrackedTask[],
): PanelTarget[] {
  return [
    ...agents.map((a) => ({ zone: "agent" as const, id: a.id })),
    ...tasks.map((t) => ({ zone: "task" as const, id: t.id })),
  ];
}

/**
 * Pure arrow-step over the flat nav list. Given the current highlighted row and
 * a direction (`+1` down, `-1` up), returns the next focus:
 *   • a {@link PanelTarget} to move to,
 *   • `null` to return to the input bar — stepping UP off the first row, or from
 *     a `current` whose row no longer exists (finished + pruned, or deleted),
 *   • the SAME `current` reference to stay put — stepping DOWN past the last row.
 * The caller distinguishes "stay" (`result === current`) from "move".
 */
export function stepPanelFocus(
  targets: PanelTarget[],
  current: PanelTarget,
  dir: 1 | -1,
): PanelTarget | null {
  const idx = targets.findIndex(
    (t) => t.zone === current.zone && t.id === current.id,
  );
  if (idx === -1) return null; // stale highlight → back to the input bar
  const next = idx + dir;
  if (next < 0) return null; // up off the top → input bar
  if (next >= targets.length) return current; // down past the bottom → stay
  return targets[next]!;
}

/** Glyph + color for an agent's run status (matches the `/hud` vocabulary). */
function agentStatusStyle(status: AgentStatus): {
  glyph: string;
  color: string;
} {
  switch (status) {
    case "running":
      return { glyph: "●", color: theme.cyan };
    case "queued":
      return { glyph: "⧗", color: "#FBBF24" };
    case "done":
      return { glyph: "✓", color: "#34D399" };
    case "failed":
      return { glyph: "✗", color: "#F87171" };
    case "killed":
      // Deliberate user kill (Ctrl-X twice) — a stop square, not a failure ✗.
      return { glyph: "◼", color: "#F87171" };
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

/** Leading marker cell: a bright pointer when highlighted, else blank alignment. */
function FocusMarker({ on }: { on: boolean }): React.ReactElement {
  return on ? (
    <Text color={theme.cyan} bold>
      {theme.pointer}
    </Text>
  ) : (
    <Text> </Text>
  );
}

function AgentTeamRow({
  agent,
  now,
  highlighted = false,
}: {
  agent: RunningAgent;
  now: number;
  highlighted?: boolean;
}): React.ReactElement {
  const { glyph, color } = agentStatusStyle(agent.status);
  const model = agent.model ? tierLabel(tierForSlug(agent.model)) : null;
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <FocusMarker on={highlighted} />
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text color={theme.violet}>{kindLabel(agent.kind)}</Text>
        <Text bold={highlighted} inverse={highlighted} wrap="truncate-end">
          {agent.title}
        </Text>
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

function TaskRow({
  task,
  highlighted = false,
}: {
  task: TrackedTask;
  highlighted?: boolean;
}): React.ReactElement {
  const { glyph, color } = taskStatusStyle(task.status);
  const strike = task.status === "done";
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <FocusMarker on={highlighted} />
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text
          dimColor={strike && !highlighted}
          bold={highlighted}
          inverse={highlighted}
          wrap="truncate-end"
        >
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
  focus = null,
  active = false,
  maxRows,
}: {
  mode?: PanelMode;
  nowFn?: () => number;
  widthFn?: () => number;
  /** The currently-highlighted panel item, or null when the input owns focus. */
  focus?: PanelFocus;
  /** Force the dock visible (the user has navigated into it) even when `auto`
   *  would otherwise hide it while idle. */
  active?: boolean;
  /** Cap the sidebar height to this many rows so it never dominates the live frame. */
  maxRows?: number;
}): React.ReactElement | null {
  const now = nowFn ?? (() => Date.now());
  const width = widthFn ?? (() => process.stdout.columns ?? 80);
  const [, setTick] = useState(0);
  const [agents, setAgents] = useState<RunningAgent[]>(() =>
    agentRegistry.snapshot(),
  );
  const [tasks, setTasks] = useState<TrackedTask[]>(() =>
    taskRegistry.snapshot(),
  );

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
  // The dock is a FLEET instrument, not a per-turn one — `auto` reveals it only
  // once work fans out (see hasFleetActivity). `/panel on` still pins it open.
  // `active` (the user has navigated into the dock) forces it visible even when
  // auto would hide it, so the highlight never lands on a hidden list.
  if (mode === "auto" && !hasFleetActivity(agents, tasks) && !active)
    return null;

  const at = now();
  const runningAgents = agents.filter((a) => a.status === "running").length;
  const doneTasks = tasks.filter((t) => t.status === "done").length;

  return (
    <Box
      flexDirection="column"
      marginLeft={1}
      // Never let flex negative space eat the sidebar: the panels are a fixed
      // PANEL_WIDTH, so any shrink clips their shared right edge and the
      // right-most border vanishes. Wide transcript content must shrink the
      // transcript column (minWidth={0} there), not this dock.
      flexShrink={0}
      gap={1}
      {...(maxRows != null ? { height: maxRows, overflow: "hidden" } : {})}
    >
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
              <AgentTeamRow
                key={a.id}
                agent={a}
                now={at}
                highlighted={focus?.zone === "agent" && focus.id === a.id}
              />
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
              <TaskRow
                key={t.id}
                task={t}
                highlighted={focus?.zone === "task" && focus.id === t.id}
              />
            ))}
          </Box>
        )}
      </Panel>

      {/* Keybinding legend — shown only while the dock holds focus, so the
          arrow-navigation controls are discoverable exactly when they apply. */}
      {focus !== null && (
        <Box paddingX={1} flexDirection="column">
          <Text dimColor>↑↓ move · Ctrl-E open · Ctrl-X×2 delete</Text>
          <Text dimColor>Esc back to prompt</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * The drilled-in agent log — shown in the main conversation column (above the
 * prompt bar) when the user opens an Agent Team row with Ctrl-E. There is no
 * per-step transcript stored for a running agent, so this surfaces the live
 * roster record we do have (status, kind, model, elapsed, current step) and
 * refreshes on the registry's `change` events plus a 1s tick so the elapsed
 * timer and current detail stay live while the agent works.
 *
 * Returns null when the id no longer resolves (the agent finished and was
 * pruned, or was deleted) so a stale focus never renders an empty frame.
 */
export function AgentFocusView({
  agentId,
  nowFn,
}: {
  agentId: string;
  nowFn?: () => number;
}): React.ReactElement | null {
  const now = nowFn ?? (() => Date.now());
  const [, setTick] = useState(0);
  const [agents, setAgents] = useState<RunningAgent[]>(() =>
    agentRegistry.snapshot(),
  );
  useEffect(() => {
    const refresh = (): void => setAgents(agentRegistry.snapshot());
    const unsub = agentRegistry.on(refresh);
    refresh();
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const { glyph, color } = agentStatusStyle(agent.status);
  const model = agent.model ? tierLabel(tierForSlug(agent.model)) : null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.cyan}
      paddingX={1}
      marginX={1}
    >
      <Box gap={1}>
        <Text color={theme.cyan} bold>
          {theme.ring}
        </Text>
        <Text color={theme.cyan} bold>
          Agent log
        </Text>
        <Text color={theme.violet}>{kindLabel(agent.kind)}</Text>
      </Box>
      <Box marginTop={1} gap={1}>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text wrap="truncate-end">{agent.title}</Text>
      </Box>
      <Box paddingLeft={2} gap={1}>
        <Text dimColor>{agent.status}</Text>
        <Text dimColor>·</Text>
        <Text dimColor>{elapsed(agent.startedAt, now())}</Text>
        {model ? (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{model}</Text>
          </>
        ) : null}
      </Box>
      {agent.detail ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {agent.detail}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>Esc to close this log.</Text>
      </Box>
    </Box>
  );
}
