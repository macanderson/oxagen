/**
 * Ink renderer for the self-playing space-invaders game (see init-game.ts for
 * the deterministic simulation this just draws). Owns its own ~120ms timer —
 * exactly the SpaceInvaders duel's pattern in repl/components.tsx — so it
 * animates independently of whatever real async work is happening elsewhere.
 */
import React, { useEffect, useReducer } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import {
  createInitialGameState,
  gameReducer,
  buildGrid,
  type CellKind,
} from "./init-game.js";

const TICK_MS = 120;

function cellColor(kind: CellKind): string {
  switch (kind) {
    case "invader":
      return theme.cyan;
    case "player":
      return theme.violet;
    case "playerBolt":
      return theme.amber;
    case "enemyBolt":
      return theme.red;
    case "explosion":
      return theme.green;
    default:
      return theme.dim;
  }
}

export interface InitGameViewProps {
  width?: number;
  /** Test seam — real timers with a tiny interval instead of mocking. */
  tickMs?: number;
}

export function InitGameView({
  width = 34,
  tickMs = TICK_MS,
}: InitGameViewProps): React.ReactElement {
  const [state, dispatch] = useReducer(
    gameReducer,
    width,
    createInitialGameState,
  );

  useEffect(() => {
    const id = setInterval(() => dispatch({ type: "tick" }), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const grid = buildGrid(state);

  return (
    <Box flexDirection="column" paddingX={1}>
      {grid.map((row, r) => (
        <Box key={r}>
          {row.map((cell, c) => (
            <Text
              key={c}
              color={cellColor(cell.kind)}
              bold={cell.kind === "player" || cell.kind === "invader"}
            >
              {cell.ch}
            </Text>
          ))}
        </Box>
      ))}
      <Text dimColor>
        {"  "}wave {state.wave} · score {state.score}
      </Text>
    </Box>
  );
}
