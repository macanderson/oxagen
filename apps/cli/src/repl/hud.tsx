/**
 * HudPanel — the `/hud` heads-up display: every agent running in this session
 * at a glance, à la Claude Code's task list.
 *
 * It is a live view of the process-wide {@link agentRegistry}: the active REPL
 * turn, any background monitors, and any in-process fleet subagents. It
 * subscribes to registry `change` events and re-renders, and ticks once a second
 * so elapsed timers advance even when nothing else changes. Rendered inline in
 * the REPL's live region (above the input row); Esc or `/hud` again closes it.
 */
import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { theme } from "../tui/theme.js";
import { activityGlyph } from "../tui/activity.js";
import { formatUsd, tierForSlug, tierLabel } from "../agent/model-router.js";
import { humanizeTokens } from "./components.js";
import {
  agentRegistry,
  type AgentKind,
  type RunningAgent,
} from "../agent/agent-registry.js";

/** Short label for what kind of agent this is. */
function kindLabel(kind: AgentKind): string {
  switch (kind) {
    case "turn":
      return "turn";
    case "subagent":
      return "subagent";
    case "monitor":
      return "monitor";
    case "fleet":
      return "fleet";
  }
}

/** Elapsed wall-clock as a compact `1m04s` / `12s`. */
function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

function AgentLine({ agent, now }: { agent: RunningAgent; now: number }): React.ReactElement {
  const { glyph, color } = activityGlyph(agent.status);
  const model = agent.model ? tierLabel(tierForSlug(agent.model)) : null;
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text dimColor>[{kindLabel(agent.kind)}]</Text>
        <Text wrap="truncate-end">{agent.title}</Text>
      </Box>
      <Box paddingLeft={2} gap={1}>
        <Text dimColor>{elapsed(agent.startedAt, now)}</Text>
        {model ? (
          <>
            <Text dimColor>·</Text>
            <Text color={theme.violet}>{model}</Text>
          </>
        ) : null}
        {agent.outputTokens ? (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{humanizeTokens(agent.outputTokens)} tok</Text>
          </>
        ) : null}
        {agent.costUsd ? (
          <>
            <Text dimColor>·</Text>
            <Text color="#34D399">{formatUsd(agent.costUsd)}</Text>
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

/**
 * The panel. Reads the registry live. `nowFn` is injectable so tests render at a
 * fixed instant; production uses the wall clock and a 1s tick.
 */
export function HudPanel({ nowFn }: { nowFn?: () => number } = {}): React.ReactElement {
  const now = nowFn ?? (() => Date.now());
  const [, setTick] = useState(0);
  const [agents, setAgents] = useState<RunningAgent[]>(() => agentRegistry.snapshot());

  useEffect(() => {
    const refresh = (): void => setAgents(agentRegistry.snapshot());
    const unsub = agentRegistry.on(refresh);
    refresh();
    // Tick so elapsed timers advance while a long agent sits idle-but-running.
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);

  const at = now();
  const running = agents.filter((a) => a.status === "running").length;
  const queued = agents.filter((a) => a.status === "queued").length;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* Header band — mirrors the fleet summary. */}
      <Box gap={1}>
        <Text color={theme.cyan} bold>
          {theme.ring}
        </Text>
        <Text color={theme.violet} bold>
          HUD
        </Text>
        <Text dimColor>·</Text>
        <Text color={theme.cyan}>{running} running</Text>
        {queued > 0 ? <Text dimColor>· {queued} queued</Text> : null}
        {done > 0 ? <Text color="#34D399">· ✓ {done}</Text> : null}
        {failed > 0 ? <Text color="#F87171">· ✗ {failed}</Text> : null}
        <Text dimColor>· Esc to close</Text>
      </Box>

      {agents.length === 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>No agents running. Start a turn or dispatch work.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} gap={1}>
          {agents.map((a) => (
            <AgentLine key={a.id} agent={a} now={at} />
          ))}
        </Box>
      )}
    </Box>
  );
}
