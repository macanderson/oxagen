/**
 * Budget Bar — full-width token budget visualization showing allocation
 * across system, procedural, retrieved, compressed, and working sections.
 */
import { Box, Text } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";

interface BudgetAllocation {
  system: number;
  procedural: number;
  retrieved: number;
  compressed: number;
  working: number;
  total: number;
  budgetTotal: number;
}

const SECTION_COLORS: Record<string, string> = {
  system: "#60A5FA",
  procedural: "#FBBF24",
  retrieved: "#34D399",
  compressed: "#A78BFA",
  working: "#F472B6",
};

function segmentBar(allocations: BudgetAllocation, width = 50): React.ReactElement {
  const { system, procedural, retrieved, compressed, working, budgetTotal } = allocations;
  const sections = [
    { name: "system", tokens: system, color: SECTION_COLORS["system"]! },
    { name: "procedural", tokens: procedural, color: SECTION_COLORS["procedural"]! },
    { name: "retrieved", tokens: retrieved, color: SECTION_COLORS["retrieved"]! },
    { name: "compressed", tokens: compressed, color: SECTION_COLORS["compressed"]! },
    { name: "working", tokens: working, color: SECTION_COLORS["working"]! },
  ];

  const segments: React.ReactElement[] = [];
  for (const section of sections) {
    const chars = Math.max(0, Math.round((section.tokens / budgetTotal) * width));
    if (chars > 0) {
      segments.push(
        <Text key={section.name} color={section.color}>
          {"█".repeat(chars)}
        </Text>,
      );
    }
  }

  // Remaining budget (empty)
  const usedChars = sections.reduce(
    (sum, s) => sum + Math.max(0, Math.round((s.tokens / budgetTotal) * width)),
    0,
  );
  const remaining = width - usedChars;
  if (remaining > 0) {
    segments.push(
      <Text key="empty" dimColor>{"░".repeat(remaining)}</Text>,
    );
  }

  return <Text>{segments}</Text>;
}

export function BudgetBar(): React.ReactElement {
  const [budget] = useState<BudgetAllocation>({
    system: 1200,
    procedural: 800,
    retrieved: 4500,
    compressed: 350,
    working: 1400,
    total: 8250,
    budgetTotal: 12000,
  });

  const usagePercent = Math.round((budget.total / budget.budgetTotal) * 100);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Box gap={2} marginBottom={1}>
        <Text bold color={theme.cyan}>◈ TOKEN BUDGET</Text>
        <Text>
          <Text bold>{budget.total.toLocaleString()}</Text>
          <Text dimColor> / {budget.budgetTotal.toLocaleString()} tokens</Text>
        </Text>
        <Text color={usagePercent < 80 ? "#34D399" : "#FBBF24"} bold>
          {usagePercent}%
        </Text>
      </Box>

      {/* Visual bar */}
      <Box>{segmentBar(budget)}</Box>

      {/* Legend */}
      <Box gap={2} marginTop={1}>
        <Text>
          <Text color={SECTION_COLORS["system"]}>■</Text>
          <Text dimColor> sys:{budget.system}</Text>
        </Text>
        <Text>
          <Text color={SECTION_COLORS["procedural"]}>■</Text>
          <Text dimColor> rules:{budget.procedural}</Text>
        </Text>
        <Text>
          <Text color={SECTION_COLORS["retrieved"]}>■</Text>
          <Text dimColor> retr:{budget.retrieved}</Text>
        </Text>
        <Text>
          <Text color={SECTION_COLORS["compressed"]}>■</Text>
          <Text dimColor> comp:{budget.compressed}</Text>
        </Text>
        <Text>
          <Text color={SECTION_COLORS["working"]}>■</Text>
          <Text dimColor> work:{budget.working}</Text>
        </Text>
      </Box>
    </Box>
  );
}
