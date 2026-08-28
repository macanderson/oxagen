/**
 * Overview Panel — the fleet rollup and real spend for this project.
 *
 * Counts by lifecycle state, the interactive-vs-fleet split, cumulative token
 * usage, and the money actually spent (summed from each run's recorded
 * `usage.costUsd`). The spend line is omitted entirely when nothing has cost
 * anything — no fabricated denominator, no fake budget bar.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatCount, formatUsd, type SessionRollup } from "./data.js";

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}): React.ReactElement {
  return (
    <Box gap={1}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  );
}

export function OverviewPanel({
  rollup,
}: {
  rollup: SessionRollup;
}): React.ReactElement {
  const { byState } = rollup;
  const hasSpend = rollup.costUsdTotal > 0;
  const hasTokens = rollup.inputTokens + rollup.outputTokens > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.violet}>
          ◈ OVERVIEW
        </Text>
      </Box>

      {/* Lifecycle tally — only non-zero states, so the row stays accurate. */}
      <Box gap={2} flexWrap="wrap">
        {rollup.active > 0 ? (
          <Text color={theme.cyan}>● {rollup.active} active</Text>
        ) : (
          <Text dimColor>● 0 active</Text>
        )}
        {byState.done > 0 ? (
          <Text color={theme.green}>✓ {byState.done} done</Text>
        ) : null}
        {byState.failed > 0 ? (
          <Text color={theme.red}>✖ {byState.failed} failed</Text>
        ) : null}
        {byState.cancelled > 0 ? (
          <Text dimColor>◼ {byState.cancelled} cancelled</Text>
        ) : null}
        {byState.orphaned > 0 ? (
          <Text color={theme.orange}>⚠ {byState.orphaned} orphaned</Text>
        ) : null}
      </Box>

      <Box gap={2} marginTop={1}>
        <Stat label="runs" value={String(rollup.total)} />
        <Stat label="fleet" value={String(rollup.fleetRuns)} />
        <Stat label="repl" value={String(rollup.interactiveRuns)} />
      </Box>

      {hasTokens ? (
        <Box gap={2} marginTop={1}>
          <Stat label="tok in" value={formatCount(rollup.inputTokens)} />
          <Stat label="tok out" value={formatCount(rollup.outputTokens)} />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>no token usage recorded yet</Text>
        </Box>
      )}

      {hasSpend ? (
        <Box gap={2} marginTop={1}>
          <Stat
            label="spend today"
            value={formatUsd(rollup.costUsdToday)}
            color={theme.green}
          />
          <Stat
            label="all-time"
            value={formatUsd(rollup.costUsdTotal)}
            color={theme.green}
          />
        </Box>
      ) : null}
    </Box>
  );
}
