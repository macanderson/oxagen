/**
 * Agent View (`oxagen view`) — a full-screen TUI for MONITORING AND AUDITING
 * agent work, wired to real local data only.
 *
 * It is the retrospective/audit companion to Mission Control (`oxagen fleet
 * watch`, the live view): it reads the same ADR-023 session store plus the
 * daemon's code-graph store and shows what agents have actually done here — runs
 * with their model, turns, duration, cost, and outcome; a real recent-activity
 * fold of the newest run; true code-graph stats; and real spend. Every number
 * comes from a source ({@link collectAgentViewData}) or is omitted; unavailable
 * sources render an explicit "not running" / "no data" state, never a fabricated
 * healthy one.
 *
 * Rendering is cheap: one real-read refresh every {@link REFRESH_MS} (the
 * mission's blessed 2–5 s cadence), never a per-frame animation loop, and a
 * single overlapping-refresh guard so a slow read can't stack. Non-TTY invocation
 * prints one plain-text snapshot and exits instead of launching Ink.
 */
import { Box, Text, render, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { theme } from "../theme.js";
import { useTerminalSize } from "../../repl/use-terminal-size.js";
import { formatClock, formatDurationMs } from "../mission-control/lib.js";
import { collectAgentViewData, formatUsd, type AgentViewData } from "./data.js";
import { SessionsPanel } from "./sessions-panel.js";
import { OverviewPanel } from "./overview-panel.js";
import { CodeGraphPanel } from "./code-graph-panel.js";
import { ActivityPanel } from "./activity-panel.js";
import { StatusBar } from "./status-bar.js";

/** Real-read refresh cadence. Whole-second reads, well under any animation budget. */
const REFRESH_MS = 3000;

function projectName(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}

export interface AgentViewProps {
  cwd: string;
  /** Injected for tests: a one-shot data source instead of the live collector. */
  collect?: (cwd: string) => Promise<AgentViewData>;
  /** Injected for tests: refresh cadence override (0 disables the interval). */
  refreshMs?: number;
}

export function AgentView({
  cwd,
  collect,
  refreshMs,
}: AgentViewProps): React.ReactElement {
  const { exit } = useApp();
  const { cols, fullscreen } = useTerminalSize();
  const [data, setData] = useState<AgentViewData | null>(null);

  const collector =
    collect ?? ((c: string) => collectAgentViewData({ cwd: c }));
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await collector(cwd);
        if (active) setData(next);
      } catch {
        // A transient read error leaves the last good frame up; the next tick retries.
      } finally {
        inFlight.current = false;
      }
    };
    void refresh();
    const period = refreshMs ?? REFRESH_MS;
    const id = period > 0 ? setInterval(() => void refresh(), period) : null;
    if (id) id.unref?.();
    return () => {
      active = false;
      if (id) clearInterval(id);
    };
    // `collector` is derived from the stable `collect`/`cwd`; re-subscribe only on those.
  }, [cwd, collect, refreshMs]);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
  });

  if (!data) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Gathering agent activity…</Text>
      </Box>
    );
  }

  const live = data.rollup.active > 0;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      {...(fullscreen ? { width: cols } : {})}
    >
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text color={theme.cyan} bold>
            {theme.ring}{" "}
          </Text>
          <Text color={theme.violet} bold>
            OXAGEN
          </Text>
          <Text dimColor> · agent audit · </Text>
          <Text>{projectName(data.projectRoot)}</Text>
          <Text dimColor> · </Text>
          {live ? (
            <Text color={theme.cyan}>live</Text>
          ) : (
            <Text dimColor>idle</Text>
          )}
        </Box>
        <Text dimColor>refreshed {formatClock(data.generatedAt)}</Text>
      </Box>

      {data.sourceError ? (
        <Box marginBottom={1} paddingX={1}>
          <Text color={theme.red}>
            Could not read the session store: {data.sourceError}
          </Text>
        </Box>
      ) : null}

      {/* Main grid: audit table + activity on the left, overview + graph on the right */}
      <Box flexDirection="row" gap={1}>
        <Box flexDirection="column" flexGrow={1} gap={1}>
          <SessionsPanel rows={data.rows} />
          <ActivityPanel lines={data.activity} />
        </Box>
        <Box flexDirection="column" width={46} gap={1}>
          <OverviewPanel rollup={data.rollup} />
          <CodeGraphPanel status={data.codeGraph} now={data.generatedAt} />
        </Box>
      </Box>

      <StatusBar
        auth={data.auth}
        daemon={data.daemon}
        codeGraph={data.codeGraph}
        generatedAt={data.generatedAt}
      />
    </Box>
  );
}

/**
 * Render a compact plain-text snapshot for non-TTY invocation (a pipe, a
 * CI log, `oxagen view | cat`). Same facts, no Ink.
 */
export function renderTextSnapshot(data: AgentViewData): string {
  const lines: string[] = [];
  lines.push(
    `OXAGEN agent audit · ${projectName(data.projectRoot)} · ${formatClock(data.generatedAt)}`,
  );
  lines.push(
    `auth: ${data.auth.label}   daemon: ${data.daemon.running ? "running" : "off"}   ` +
      `code graph: ${data.codeGraph.state}`,
  );
  const r = data.rollup;
  lines.push(
    `runs: ${r.total} (${r.active} active, ${r.fleetRuns} fleet, ${r.interactiveRuns} repl)   ` +
      `spend: ${formatUsd(r.costUsdTotal)} all-time / ${formatUsd(r.costUsdToday)} today`,
  );
  if (data.sourceError)
    lines.push(`! session store unreadable: ${data.sourceError}`);
  lines.push("");
  if (data.rows.length === 0) {
    lines.push("No agent runs recorded for this project yet.");
  } else {
    lines.push("recent runs:");
    for (const row of data.rows.slice(0, 10)) {
      lines.push(
        `  ${row.state.padEnd(9)} ${row.sid}  ${row.owner === "worker" ? "fleet" : "repl "}  ` +
          `${formatDurationMs(row.durationMs).padStart(6)}  ${formatUsd(row.usage.costUsd).padStart(8)}  ` +
          `${row.title}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Launch the dashboard. Interactive on a TTY; a one-shot text snapshot otherwise
 * (so the process never hangs a pipe).
 */
export async function launchAgentView(
  opts: { cwd?: string } = {},
): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  if (!process.stdout.isTTY) {
    const data = await collectAgentViewData({ cwd });
    process.stdout.write(renderTextSnapshot(data) + "\n");
    return;
  }
  const { waitUntilExit } = render(<AgentView cwd={cwd} />);
  await waitUntilExit();
}
