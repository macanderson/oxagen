/**
 * vitals-bar.tsx — Mission Control's one-line header band (spec §5).
 *
 * The fleet at a glance: live counts by state, the cumulative token + dollar
 * spend summed across the whole roster, the project the fleet is working, and
 * an elapsed clock since the view opened. When draining (ctrl-c once) it swaps
 * its right edge for a drain readout so the operator sees why it hasn't quit.
 *
 * Pure presentation — every number is computed by the caller from roster data
 * (see lib.ts `countByState` / `sumUsage`); this only lays it out.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatUsd } from "../../agent/model-router.js";
import { humanizeTokens } from "../../repl/components.js";
import { formatElapsed, type StateCounts } from "./lib.js";
import type { TurnUsage } from "../../sessions/events.js";

export function VitalsBar({
  counts,
  usage,
  project,
  elapsedMs,
  draining,
  drainingCount,
}: {
  counts: StateCounts;
  usage: TurnUsage;
  project: string;
  elapsedMs: number;
  draining: boolean;
  drainingCount: number;
}): React.ReactElement {
  const tokens = usage.inputTokens + usage.outputTokens;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text>
          <Text color={theme.cyan} bold>
            ●{" "}
          </Text>
          <Text color={theme.cyan}>{counts.running}</Text>
          <Text dimColor> running</Text>
        </Text>
        <Text dimColor>◐ {counts.waiting} waiting</Text>
        {counts.queued > 0 ? (
          <Text dimColor>◔ {counts.queued} queued</Text>
        ) : null}
        <Text>
          <Text color={theme.green}>✓ {counts.done}</Text>
          <Text dimColor> done</Text>
        </Text>
        {counts.failed > 0 ? (
          <Text color={theme.red}>✖ {counts.failed} failed</Text>
        ) : null}
        {counts.orphaned > 0 ? (
          <Text color={theme.orange}>⚠ {counts.orphaned} orphaned</Text>
        ) : null}
        <Text dimColor>│</Text>
        <Text dimColor>
          <Text color={theme.green}>{formatUsd(usage.costUsd)}</Text>
          {" · "}
          <Text color={theme.cyan}>{humanizeTokens(tokens)}</Text> tok
        </Text>
      </Box>

      <Box gap={2}>
        {draining ? (
          <Text color={theme.amber}>draining… {drainingCount} running</Text>
        ) : null}
        <Text dimColor wrap="truncate">
          {project}
        </Text>
        <Text dimColor>{formatElapsed(elapsedMs)}</Text>
      </Box>
    </Box>
  );
}
