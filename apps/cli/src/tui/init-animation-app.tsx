/**
 * The Ink app that plays during `oxagen init`'s real async work: the
 * self-playing space-invaders game (init-game-view.tsx) plus a live readout
 * of init's actual phases, driven by the InitProgressEvent stream off
 * `emitter` (see commands/init.ts's onProgress). The moment the
 * domain-inference phase resolves — one way or another — init's real
 * background work (settings + code graph + domains) is done, so this swaps
 * to the OXAGEN reveal (init-reveal-view.tsx) and calls `onReady` once that
 * reveal has held for a beat. init-animation.tsx uses `onReady` to unmount
 * before the workspace linker's interactive prompts (if any) get to run.
 */
import React, { useEffect, useReducer } from "react";
import { Box, Text } from "ink";
import type { EventEmitter } from "node:events";
import { theme } from "./theme.js";
import { InitGameView } from "./init-game-view.js";
import { InitRevealView } from "./init-reveal-view.js";
import type { InitProgressEvent } from "../commands/init-engine.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROGRESS_STEPS = 24; // rendered width of the file-progress bar
const BLINK_PERIOD = 6; // ticks per pulse cycle of the phase label

const PHASE_LABEL: Record<InitProgressEvent["phase"], string> = {
  settings: "Scaffolding settings…",
  graph: "Building code graph…",
  domains: "Inferring domains…",
  link: "Linking workspace…",
};

/** A PROGRESS_STEPS-wide block bar for `done/total`; all-empty when total is unknown (0). */
function progressBar(done: number, total: number): string {
  if (total <= 0) return "░".repeat(PROGRESS_STEPS);
  const filled = Math.round((done / total) * PROGRESS_STEPS);
  return "█".repeat(filled) + "░".repeat(PROGRESS_STEPS - filled);
}

interface State {
  label: string;
  filesDone: number;
  filesTotal: number;
  domainsFound: number | null;
  revealing: boolean;
  frame: number;
}

type Action = { kind: "event"; e: InitProgressEvent } | { kind: "tick" } | { kind: "reveal" };

function initialState(): State {
  return {
    label: "Starting…",
    filesDone: 0,
    filesTotal: 0,
    domainsFound: null,
    revealing: false,
    frame: 0,
  };
}

function reducer(s: State, a: Action): State {
  if (a.kind === "tick") return { ...s, frame: s.frame + 1 };
  if (a.kind === "reveal") return { ...s, revealing: true };

  const e = a.e;
  switch (e.phase) {
    case "settings":
      return { ...s, label: PHASE_LABEL.settings };
    case "graph":
      if (e.status === "progress") {
        // Throttle to ~PROGRESS_STEPS redraws regardless of repo size — a
        // 5,000-file monorepo shouldn't dispatch 5,000 state updates.
        const step = Math.max(1, Math.floor(e.filesTotal / PROGRESS_STEPS));
        if (e.filesDone !== e.filesTotal && e.filesDone - s.filesDone < step) return s;
        return { ...s, label: PHASE_LABEL.graph, filesDone: e.filesDone, filesTotal: e.filesTotal };
      }
      return { ...s, label: PHASE_LABEL.graph };
    case "domains":
      if (e.status === "start") {
        return { ...s, label: PHASE_LABEL.domains, filesTotal: e.totalFiles, filesDone: 0 };
      }
      if (e.status === "done") return { ...s, domainsFound: e.domains.length };
      if (e.status === "skipped") return { ...s, domainsFound: 0 };
      return s;
    case "link":
      return { ...s, label: PHASE_LABEL.link };
    default:
      return s;
  }
}

export interface InitAnimationAppProps {
  emitter: EventEmitter;
  /** Called once the OXAGEN reveal has fully played and held for a beat. */
  onReady: () => void;
  width?: number;
  /** Test seams — real timers with tiny durations instead of mocking. */
  gameTickMs?: number;
  spinnerTickMs?: number;
  revealTickMs?: number;
  revealHoldMs?: number;
}

export function InitAnimationApp({
  emitter,
  onReady,
  width,
  gameTickMs,
  spinnerTickMs = 120,
  revealTickMs,
  revealHoldMs,
}: InitAnimationAppProps): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    const onEvent = (e: InitProgressEvent): void => {
      dispatch({ kind: "event", e });
      // domains resolving — skipped or done — is the terminal event of
      // init's real background work. Reveal now rather than waiting on the
      // (possibly interactive, possibly absent) workspace-link step after it.
      if (e.phase === "domains" && e.status !== "start") {
        dispatch({ kind: "reveal" });
      }
    };
    emitter.on("progress", onEvent);
    return () => {
      emitter.off("progress", onEvent);
    };
  }, [emitter]);

  useEffect(() => {
    if (state.revealing) return;
    const id = setInterval(() => dispatch({ kind: "tick" }), spinnerTickMs);
    return () => clearInterval(id);
  }, [state.revealing, spinnerTickMs]);

  if (state.revealing) {
    return <InitRevealView onDone={onReady} tickMs={revealTickMs} holdMs={revealHoldMs} />;
  }

  const bar = progressBar(state.filesDone, state.filesTotal);
  const blink = state.frame % BLINK_PERIOD < BLINK_PERIOD / 2;

  return (
    <Box flexDirection="column">
      <InitGameView width={width} tickMs={gameTickMs} />
      <Box marginTop={1} paddingX={1}>
        <Text color={theme.cyan}>{SPINNER[state.frame % SPINNER.length]} </Text>
        <Text bold={blink} dimColor={!blink}>
          {state.label}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{bar}</Text>
        {state.filesTotal > 0 && (
          <Text dimColor>
            {" "}
            {state.filesDone}/{state.filesTotal} files
          </Text>
        )}
        {state.domainsFound !== null && (
          <Text dimColor>
            {" "}
            · {state.domainsFound} domain{state.domainsFound === 1 ? "" : "s"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
