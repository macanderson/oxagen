/**
 * Animated dragon creature component.
 * 
 * Modes:
 * - passive: Loops through breathing animation continuously
 * - interactive: Responds to key presses with fire breath
 * 
 * Animation runs at 200ms per frame (5 FPS) for smooth terminal rendering
 * without overwhelming the terminal's refresh capabilities.
 */
import { Box, Text, useInput } from "ink";
import React, { useState, useEffect, useCallback } from "react";
import { theme } from "../theme.js";
import { DRAGON_FRAMES, ANIMATION_CONFIG } from "./creature-frames.js";

export interface AnimatedCreatureProps {
  /** Interactive mode: fire breath on space/enter; passive: loop continuously */
  mode?: "interactive" | "passive";
  /** Callback when user interacts (only in interactive mode) */
  onInteraction?: () => void;
}

export function AnimatedCreature({
  mode = "passive",
  onInteraction,
}: AnimatedCreatureProps): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);
  const [isFiring, setIsFiring] = useState(false);

  // Auto-advance animation frames
  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => {
        // In interactive mode, stay on fire frames when firing
        if (mode === "interactive" && isFiring) {
          // Alternate between frames 4 and 5 for fire effect
          return prev === 4 ? 5 : 4;
        }
        // Normal breathing cycle (frames 0-3)
        return (prev + 1) % 4;
      });
    }, ANIMATION_CONFIG.frameDelay);

    return () => clearInterval(interval);
  }, [mode, isFiring]);

  // Fire breath effect timeout (returns to breathing after 1 second)
  useEffect(() => {
    if (isFiring) {
      const timeout = setTimeout(() => {
        setIsFiring(false);
      }, 1000);
      return () => clearTimeout(timeout);
    }
  }, [isFiring]);

  // Handle user interaction in interactive mode
  const triggerFireBreath = useCallback(() => {
    if (mode === "interactive") {
      setIsFiring(true);
      setFrameIndex(4); // Jump to fire frame
      onInteraction?.();
    }
  }, [mode, onInteraction]);

  useInput((input, key) => {
    if (mode === "interactive") {
      if (input === " " || key.return) {
        triggerFireBreath();
      }
    }
  });

  // Get current frame (fire frames override breathing when firing)
  const currentFrame = isFiring ? DRAGON_FRAMES[frameIndex] : DRAGON_FRAMES[frameIndex];

  // Split frame into lines for rendering
  const lines = currentFrame?.split("\n").filter((line) => line.length > 0) ?? [];

  // Color scheme: violet for body, cyan for fire effects
  const getLineColor = (line: string): string => {
    // Fire characters use cyan
    if (line.includes("*") || line.includes("≈") || line.includes("~")) {
      return theme.cyan;
    }
    // Body uses violet
    return theme.violet;
  };

  return (
    <Box flexDirection="column" alignItems="center" paddingY={2}>
      {/* Creature animation */}
      <Box flexDirection="column" alignItems="center">
        {lines.map((line, i) => (
          <Text key={i} color={getLineColor(line)} bold={isFiring}>
            {line}
          </Text>
        ))}
      </Box>

      {/* Interactive hint */}
      {mode === "interactive" && (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>
            Press{" "}
            <Text color={theme.cyan} bold>
              SPACE
            </Text>{" "}
            or{" "}
            <Text color={theme.cyan} bold>
              ENTER
            </Text>{" "}
            to make the dragon breathe fire!
          </Text>
        </Box>
      )}

      {/* Status indicator for interactive mode */}
      {mode === "interactive" && isFiring && (
        <Box marginTop={1} justifyContent="center">
          <Text color={theme.cyan} bold>
            🔥 FIRE BREATH! 🔥
          </Text>
        </Box>
      )}
    </Box>
  );
}
