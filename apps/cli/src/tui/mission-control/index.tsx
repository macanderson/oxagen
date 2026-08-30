/**
 * index.tsx — the Mission Control entry point (spec §5, ADR-023).
 *
 * `launchMissionControl` is the single seam the `oxagen fleet` command wires to:
 * it enters the alternate screen on a TTY, starts the manager's fleet
 * observation, renders {@link MissionControlApp}, and resolves once the user
 * exits. Alt-screen restore and `manager.stop()` run on EVERY exit path — a
 * clean quit, an uncaught error, or a signal — so a crash never strands the
 * terminal in the alternate buffer, mirroring `launchRepl`.
 *
 * Ctrl-C is intercepted inside the app (drain in-process runners, then exit;
 * ADR-023 §5), so Ink's own ctrl-c exit is disabled. A SIGINT/SIGTERM *signal*
 * (an external kill, or a terminal that delivers ctrl-c as a signal) gets the
 * SAME two-step drain: the first drains and unmounts, a second exits hard.
 */
import { render } from "ink";
import React from "react";
import { enterFullscreen } from "../../repl/alt-screen.js";
import { exitBySignal } from "../../lib/exit-by-signal.js";
import { MissionControlApp } from "./mission-control-app.js";
import type { FleetSessionManager } from "../../sessions/manager.js";
import type { SessionStore } from "../../sessions/store.js";

export interface MissionControlOptions {
  store: SessionStore;
  manager: FleetSessionManager;
  cwd: string;
  /** Open directly focused on this session (from `fleet attach <sid>`). */
  focusSid?: string;
}

export async function launchMissionControl(
  opts: MissionControlOptions,
): Promise<void> {
  const { store, manager, cwd, focusSid } = opts;

  const isTTY = Boolean(process.stdout.isTTY);
  const fullscreenHandle = isTTY ? enterFullscreen(process.stdout) : null;
  // Best-effort net for abnormal termination — `"exit"` fires for a clean exit
  // and `process.exit`, but NOT for a signal kill (the handlers below cover it).
  if (fullscreenHandle) process.once("exit", fullscreenHandle.leave);

  manager.start();

  let unmount: (() => void) | null = null;
  let draining = false;
  const cleanup = (): void => {
    fullscreenHandle?.leave();
    manager.stop();
  };
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (draining) {
      cleanup();
      // Die by re-raised signal, not `process.exit` — exit()-time C++ static
      // destructors abort when duckdb/onnxruntime worker threads are still
      // live (see exit-by-signal.ts). The shell still sees 128+n.
      exitBySignal(signal);
      return;
    }
    draining = true;
    void manager.drain().finally(() => unmount?.());
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const instance = render(
      <MissionControlApp
        store={store}
        manager={manager}
        cwd={cwd}
        {...(focusSid !== undefined ? { focusSid } : {})}
      />,
      // The app owns ctrl-c (drain, then exit), so Ink must not exit on it.
      { exitOnCtrlC: false },
    );
    unmount = instance.unmount;
    await instance.waitUntilExit();
  } finally {
    cleanup();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
