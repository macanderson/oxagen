/**
 * Full-screen welcome screen with animated dragon.
 * 
 * Features:
 * - Styled header with OXAGEN branding
 * - Animated dragon creature (breathing + fire)
 * - Interactive mode: responds to user input
 * - Passive mode: loops animation continuously
 * - Action menu with navigation hints
 * 
 * This is the entry point shown when launching `oxagen welcome` or as a
 * startup screen before the REPL.
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useState } from "react";
import { theme } from "../theme.js";
import { Header } from "./header.js";
import { AnimatedCreature } from "./animated-creature.js";
import pkg from "../../../package.json" with { type: "json" };

export interface WelcomeScreenProps {
  /** Display mode */
  mode?: "interactive" | "passive";
  /** Auto-exit after N seconds in passive mode (0 = stay forever) */
  autoExitSeconds?: number;
  /** Callback when user wants to start the REPL */
  onStartRepl?: () => void;
  /** Show additional action menu */
  showActions?: boolean;
}

export function WelcomeScreen({
  mode = "interactive",
  autoExitSeconds = 0,
  onStartRepl,
  showActions = true,
}: WelcomeScreenProps): React.ReactElement {
  const { exit } = useApp();
  const [interactionCount, setInteractionCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Auto-exit timer for passive mode
  React.useEffect(() => {
    if (mode === "passive" && autoExitSeconds > 0) {
      const interval = setInterval(() => {
        setElapsedSeconds((prev) => {
          const next = prev + 1;
          if (next >= autoExitSeconds) {
            exit();
          }
          return next;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [mode, autoExitSeconds, exit]);

  // Handle keyboard input
  useInput((input, key) => {
    if (mode === "interactive") {
      // ESC or Ctrl-C to exit
      if (key.escape || (key.ctrl && input === "c")) {
        exit();
      }
      // Enter or 'r' to start REPL
      if (key.return || input === "r") {
        onStartRepl?.();
      }
      // 'q' to quit
      if (input === "q") {
        exit();
      }
    }
  });

  const handleCreatureInteraction = (): void => {
    setInteractionCount((prev) => prev + 1);
  };

  return (
    <Box flexDirection="column" height="100%" padding={1}>
      {/* Header */}
      <Header
        version={pkg.version}
        status={mode === "interactive" ? "Ready" : "Demo"}
        connected={true}
      />

      {/* Animated creature */}
      <Box flexGrow={1} justifyContent="center" alignItems="center">
        <AnimatedCreature
          mode={mode}
          onInteraction={handleCreatureInteraction}
        />
      </Box>

      {/* Action menu */}
      {showActions && mode === "interactive" && (
        <Box flexDirection="column" paddingX={4} paddingY={2} borderStyle="round" borderColor={theme.violet}>
          <Box marginBottom={1} justifyContent="center">
            <Text color={theme.violet} bold>
              ═══ QUICK START ═══
            </Text>
          </Box>

          <Box flexDirection="column" gap={1}>
            <Box>
              <Text color={theme.cyan} bold>
                [R]
              </Text>
              <Text dimColor> or </Text>
              <Text color={theme.cyan} bold>
                ENTER
              </Text>
              <Text> · Start the interactive REPL</Text>
            </Box>

            <Box>
              <Text color={theme.cyan} bold>
                [Q]
              </Text>
              <Text dimColor> or </Text>
              <Text color={theme.cyan} bold>
                ESC
              </Text>
              <Text> · Exit to shell</Text>
            </Box>

            <Box marginTop={1}>
              <Text dimColor>
                Or run:{" "}
                <Text color={theme.violet}>oxagen agents</Text>
                {" · "}
                <Text color={theme.violet}>oxagen view</Text>
                {" · "}
                <Text color={theme.violet}>oxagen --help</Text>
              </Text>
            </Box>
          </Box>

          {/* Interaction counter (easter egg) */}
          {interactionCount > 5 && (
            <Box marginTop={1} justifyContent="center">
              <Text color={theme.cyan} dimColor>
                🐉 The dragon appreciates your enthusiasm! ({interactionCount} fire breaths)
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* Footer with auto-exit countdown */}
      {mode === "passive" && autoExitSeconds > 0 && (
        <Box justifyContent="center" marginTop={1}>
          <Text dimColor>
            Auto-exit in {autoExitSeconds - elapsedSeconds}s...
          </Text>
        </Box>
      )}

      {/* Status bar */}
      <Box marginTop={1} justifyContent="space-between" paddingX={2}>
        <Box>
          <Text dimColor>
            Mode: <Text color={theme.violet}>{mode}</Text>
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            Press <Text color={theme.cyan}>?</Text> for help
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// ── Launch Function ───────────────────────────────────────────────────────────

export interface LaunchWelcomeOptions {
  /** Display mode */
  mode?: "interactive" | "passive";
  /** Auto-exit after N seconds (passive mode only) */
  autoExitSeconds?: number;
  /** Start REPL when user presses R or Enter */
  startReplOnAction?: boolean;
}

export async function launchWelcomeScreen(
  options: LaunchWelcomeOptions = {},
): Promise<void> {
  const { render: renderInk } = await import("ink");

  let startRepl = false;

  const { waitUntilExit } = renderInk(
    <WelcomeScreen
      mode={options.mode ?? "interactive"}
      autoExitSeconds={options.autoExitSeconds ?? 0}
      showActions={true}
      onStartRepl={() => {
        if (options.startReplOnAction) {
          startRepl = true;
          // We'll exit the welcome screen and the caller can launch REPL
        }
      }}
    />,
  );

  await waitUntilExit();

  // If configured to start REPL, the caller should handle it
  // This is a clean separation — welcome screen exits, then REPL launches
  if (startRepl && options.startReplOnAction) {
    const { launchRepl } = await import("../../repl/interactive.js");
    await launchRepl();
  }
}
