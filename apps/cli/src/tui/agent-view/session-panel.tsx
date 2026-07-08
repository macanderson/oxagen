/**
 * Session Panel — shows the current event-sourced session state:
 * turn count, events, fork history, and outcome tracking.
 */
import { Box, Text } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";

interface SessionInfo {
  id: string;
  turns: number;
  events: number;
  status: "active" | "completed" | "forked";
  duration: string;
  forks: number;
  outcomes: { success: number; failure: number; interrupted: number };
  recentEvents: Array<{ type: string; turnId: string; age: string }>;
}

const STATUS_COLORS: Record<string, string> = {
  active: "#34D399",
  completed: theme.dim,
  forked: "#A78BFA",
};

const EVENT_SYMBOLS: Record<string, string> = {
  turn_start: "▶",
  turn_end: "■",
  tool_call: "🔧",
  tool_result: "📋",
  context_compiled: "⟐",
  model_request: "↑",
  model_response: "↓",
  memory_write: "💾",
  session_start: "●",
};

export function SessionPanel(): React.ReactElement {
  const [session] = useState<SessionInfo>({
    id: "sess_7k2m9x",
    turns: 4,
    events: 23,
    status: "active",
    duration: "3m 42s",
    forks: 0,
    outcomes: { success: 3, failure: 0, interrupted: 1 },
    recentEvents: [
      { type: "context_compiled", turnId: "t4", age: "2s" },
      { type: "tool_call", turnId: "t4", age: "5s" },
      { type: "tool_result", turnId: "t4", age: "4s" },
      { type: "memory_write", turnId: "t4", age: "3s" },
      { type: "model_response", turnId: "t4", age: "1s" },
    ],
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="#F472B6">◈ SESSION</Text>
        <Text dimColor>  {session.id}</Text>
      </Box>

      {/* Session stats */}
      <Box gap={2}>
        <Box gap={1}>
          <Text dimColor>Status:</Text>
          <Text color={STATUS_COLORS[session.status]} bold>{session.status}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Duration:</Text>
          <Text>{session.duration}</Text>
        </Box>
      </Box>

      <Box gap={2} marginTop={1}>
        <Box gap={1}>
          <Text dimColor>Turns:</Text>
          <Text bold>{session.turns}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Events:</Text>
          <Text bold>{session.events}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Forks:</Text>
          <Text>{session.forks}</Text>
        </Box>
      </Box>

      {/* Outcomes */}
      <Box gap={2} marginTop={1}>
        <Text color="#34D399">✓{session.outcomes.success}</Text>
        <Text color="#EF4444">✗{session.outcomes.failure}</Text>
        <Text color="#FBBF24">◌{session.outcomes.interrupted}</Text>
      </Box>

      {/* Recent event stream */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Event stream:</Text>
        {session.recentEvents.map((ev, i) => (
          <Box key={i} paddingLeft={1} gap={1}>
            <Text>{EVENT_SYMBOLS[ev.type] ?? "·"}</Text>
            <Box width={18}>
              <Text dimColor>{ev.type}</Text>
            </Box>
            <Text dimColor>{ev.age}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
