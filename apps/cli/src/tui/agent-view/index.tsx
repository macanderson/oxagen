/**
 * Agent View — full-screen TUI dashboard showing the Oxagen context engine in
 * real-time. Shows memory writes, context compilation, session state,
 * token budgets, and code graph activity.
 *
 * Inspired by mission-control-style developer dashboards.
 * Launch with: `oxagen view`
 */
import { Box, Text, render } from "ink";
import React, { useState, useEffect } from "react";
import { theme } from "../theme.js";
import { MemoryPanel } from "./memory-panel.js";
import { CompilePanel } from "./compile-panel.js";
import { SessionPanel } from "./session-panel.js";
import { BudgetBar } from "./budget-bar.js";
import { ActivityFeed } from "./activity-feed.js";
import { StatusBar } from "./status-bar.js";

export function AgentView(): React.ReactElement {
  const [tick, setTick] = useState(0);

  // Refresh every second for live data
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={theme.cyan} bold>{theme.ring} </Text>
        <Text color={theme.violet} bold>OXAGEN</Text>
        <Text dimColor>  ·  agent memory engine  ·  </Text>
        <Text color={theme.cyan}>live</Text>
      </Box>

      {/* Main grid: 2 columns */}
      <Box flexDirection="row" gap={1}>
        {/* Left column: Memory + Activity */}
        <Box flexDirection="column" flexGrow={1} gap={1}>
          <MemoryPanel />
          <ActivityFeed />
        </Box>

        {/* Right column: Compile + Session */}
        <Box flexDirection="column" width={44} gap={1}>
          <CompilePanel />
          <SessionPanel />
        </Box>
      </Box>

      {/* Budget bar (full width) */}
      <Box marginTop={1}>
        <BudgetBar />
      </Box>

      {/* Status bar */}
      <StatusBar tick={tick} />
    </Box>
  );
}

export function launchAgentView(): void {
  render(<AgentView />);
}
