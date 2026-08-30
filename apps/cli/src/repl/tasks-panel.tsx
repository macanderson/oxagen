/**
 * tasks-panel.tsx — the Ctrl+T "planner tasks inspector".
 *
 * A takeover panel (same shape as files-panel / diff-panel) that shows the
 * current turn's task list read from the shared {@link taskRegistry}: the
 * ordered stages the planning/coordinator agent laid out, each with a status
 * glyph (pending ○ / running ◐ / done ✓ / failed ✗), its human label, and the
 * elapsed wall-clock for a running or finished stage. ↑/↓ move the selection
 * (wrapping), Enter/→ drills into a single task's detail (full label, status,
 * timing), Esc steps back out of the detail — or closes the panel from the list.
 *
 * It stays live by re-reading the injected `snapshot` on a short interval
 * (matching how AgentSidebar keeps its elapsed timers advancing): a fresh array
 * each tick re-renders the panel so a running stage's timer ticks up and a
 * status transition (pending → in_progress → done) surfaces without any manual
 * refresh. `snapshot`/`now` are injectable seams so tests drive the panel
 * against a canned plan without touching the process-wide registry singleton.
 */
import { Box, Text, useInput } from "ink";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { theme } from "../tui/theme.js";
import {
  taskRegistry,
  type TaskStatus,
  type TrackedTask,
} from "../agent/task-registry.js";
import { visibleWindow } from "./slash-menu.js";

/** Max task rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_TASKS = 12;

/** How often (ms) the panel re-reads the snapshot so timers/statuses stay live. */
export const TASKS_POLL_MS = 500;

/** Default snapshot source — the process-wide task registry. Module-level so it
 *  is referentially stable (an inline default would re-fire the poll effect). */
const defaultTaskSnapshot = (): TrackedTask[] => taskRegistry.snapshot();

/** Glyph + color for a task's status — a live checklist vocabulary shared with
 *  the AgentSidebar's Task Progress panel. */
export function taskStatusStyle(status: TaskStatus): {
  glyph: string;
  color: string;
} {
  switch (status) {
    case "pending":
      return { glyph: "○", color: theme.dim };
    case "in_progress":
      return { glyph: "◐", color: theme.cyan };
    case "done":
      return { glyph: "✓", color: theme.green };
    case "failed":
      return { glyph: "✗", color: theme.red };
  }
}

/** Compact elapsed wall-clock, e.g. `12s` / `1m04s`; empty for a zero span. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * The elapsed span to show for a task: a running stage counts up from its start
 * to `now`; a finished (done/failed) stage shows how long it took (start →
 * last update); a pending stage shows nothing (it hasn't started). Returns null
 * when there is nothing meaningful to display.
 */
export function taskElapsedMs(task: TrackedTask, now: number): number | null {
  if (task.status === "in_progress") return now - task.createdAt;
  if (task.status === "done" || task.status === "failed")
    return task.updatedAt - task.createdAt;
  return null;
}

export interface TasksPanelProps {
  /** False while another surface owns the keyboard; the panel ignores keys. */
  active?: boolean;
  onClose: () => void;
  width?: number;
  /** Test seam: source of the task list (defaults to the registry singleton). */
  snapshot?: () => TrackedTask[];
  /** Test seam: clock for elapsed timers. */
  now?: () => number;
  /** Test seam: how often to re-read the snapshot. */
  pollMs?: number;
}

export function TasksPanel({
  active = true,
  onClose,
  width = 84,
  snapshot = defaultTaskSnapshot,
  now = Date.now,
  pollMs = TASKS_POLL_MS,
}: TasksPanelProps): React.ReactElement {
  const [tasks, setTasks] = useState<TrackedTask[]>(() => snapshot());
  const [selected, setSelected] = useState(0);
  const [drilled, setDrilled] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Stay live: re-read the snapshot on a short interval. A fresh array each tick
  // re-renders so a running stage's timer advances and status transitions show.
  useEffect(() => {
    const refresh = (): void => {
      if (mountedRef.current) setTasks(snapshot());
    };
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [snapshot, pollMs]);

  const clampedSelected = Math.min(selected, Math.max(0, tasks.length - 1));
  const current = tasks[clampedSelected];

  const doneCount = useMemo(
    () => tasks.filter((t) => t.status === "done").length,
    [tasks],
  );

  const back = useCallback((): void => {
    setDrilled(false);
  }, []);

  useInput(
    (input, key) => {
      if (drilled) {
        // Esc/← step back to the list before closing the panel.
        if (key.escape || key.leftArrow) back();
        return;
      }
      if (key.escape) {
        onClose();
        return;
      }
      if (tasks.length === 0) return;
      if (key.upArrow) {
        setSelected((clampedSelected - 1 + tasks.length) % tasks.length);
        return;
      }
      if (key.downArrow) {
        setSelected((clampedSelected + 1) % tasks.length);
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

  // Detail view — the selected task expanded.
  if (drilled && current) {
    const { glyph, color } = taskStatusStyle(current.status);
    const elapsed = taskElapsedMs(current, at);
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.violet}
        paddingX={1}
        width={width}
      >
        <Box gap={1}>
          <Text color={color} bold>
            {glyph}
          </Text>
          <Text color={theme.violet} bold wrap="truncate-end">
            {current.title}
          </Text>
        </Box>
        <Box marginTop={1} paddingLeft={2} flexDirection="column">
          <Box gap={1}>
            <Text dimColor>status</Text>
            <Text color={color}>{current.status}</Text>
          </Box>
          {elapsed !== null ? (
            <Box gap={1}>
              <Text dimColor>
                {current.status === "in_progress" ? "running" : "took"}
              </Text>
              <Text>{formatElapsed(elapsed)}</Text>
            </Box>
          ) : null}
          {current.detail ? (
            <Box gap={1} width={innerWidth}>
              <Text dimColor>detail</Text>
              <Text wrap="truncate-end">{current.detail}</Text>
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>esc/← back to the task list</Text>
        </Box>
      </Box>
    );
  }

  const { start, end } = visibleWindow(
    tasks.length,
    clampedSelected,
    MAX_VISIBLE_TASKS,
  );
  const visible = tasks.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={theme.violet} bold>
          {"Task Progress "}
        </Text>
        <Text dimColor>
          · {tasks.length} task{tasks.length === 1 ? "" : "s"} · {doneCount}{" "}
          done
        </Text>
      </Box>

      {tasks.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No plan yet — the turn's stages will appear here as the planner lays
            them out.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((task, i) => {
            const idx = start + i;
            const isSelected = idx === clampedSelected;
            const { glyph, color } = taskStatusStyle(task.status);
            const elapsed = taskElapsedMs(task, at);
            const strike = task.status === "done" && !isSelected;
            return (
              <Box key={task.id} width={innerWidth}>
                <Text
                  color={isSelected ? theme.violet : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={2}>
                  <Text color={color} bold>
                    {glyph}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    color={isSelected ? theme.violet : undefined}
                    bold={isSelected}
                    dimColor={strike}
                    wrap="truncate-end"
                  >
                    {task.title}
                  </Text>
                </Box>
                {elapsed !== null ? (
                  <Box marginLeft={1}>
                    <Text dimColor>{formatElapsed(elapsed)}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {tasks.length > MAX_VISIBLE_TASKS
            ? `${clampedSelected + 1}/${tasks.length} · `
            : ""}
          ↑↓ navigate · ↵/→ detail · esc close
        </Text>
      </Box>
    </Box>
  );
}
