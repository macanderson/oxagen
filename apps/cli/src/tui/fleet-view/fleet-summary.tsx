/**
 * Fleet Summary — the header band of the agents screen.
 *
 * Carries the ◯ OXAGEN wordmark line and adds the live
 * fleet vitals: how many agents are running / queued / done / failed, the running
 * token total, the estimated dollar cost so far, and the concurrency cap. It is a
 * pure function of the current {@link FleetSnapshot}.
 */
import { Box, Text } from "ink";
import React from "react";
import { theme } from "../theme.js";
import { formatUsd } from "../../agent/model-router.js";
import { humanizeTokens } from "../../repl/components.js";
import type { FleetSnapshot } from "../../agent/fleet/types.js";

export function FleetSummary({
  snap,
}: {
  snap: FleetSnapshot;
}): React.ReactElement {
  const tokens = snap.totals.inputTokens + snap.totals.outputTokens;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Wordmark line. */}
      <Box>
        <Text color={theme.cyan} bold>
          {theme.ring}{" "}
        </Text>
        <Text color={theme.violet} bold>
          OXAGEN
        </Text>
        <Text dimColor>{"  ·  agent fleet  ·  "}</Text>
        <Text color={theme.cyan}>{snap.concurrency}× concurrency</Text>
      </Box>

      {/* Live vitals. */}
      <Box gap={2}>
        <Text>
          <Text color={theme.cyan} bold>
            ●{" "}
          </Text>
          <Text color={theme.cyan}>{snap.runningCount}</Text>
          <Text dimColor> running</Text>
        </Text>
        <Text dimColor>· {snap.queuedCount} queued</Text>
        <Text>
          <Text color="#34D399">✓ {snap.doneCount}</Text>
          <Text dimColor> done</Text>
        </Text>
        {snap.failedCount > 0 ? (
          <Text color="#F87171">✗ {snap.failedCount} failed</Text>
        ) : null}
        <Text dimColor>│</Text>
        <Text dimColor>
          Σ <Text color={theme.cyan}>{humanizeTokens(tokens)}</Text> tok
        </Text>
        <Text dimColor>
          · <Text color="#34D399">{formatUsd(snap.totals.costUsd)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
