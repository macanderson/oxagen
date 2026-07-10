/**
 * Launch `oxagen init` with the space-invaders / OXAGEN-reveal animation.
 *
 * TTY (and OXAGEN_CLI_FUN !== "0", and not --json) -> InitAnimationApp plays
 * while runInit's real phases (settings, code graph, domain inference) run in
 * the background, then reveals OXAGEN and hands off before any interactive
 * step (the workspace linker) writes to stdout.
 *
 * Non-TTY, --json, or OXAGEN_CLI_FUN=0 -> plain line-by-line progress on
 * stderr — exactly the phase transitions the animation shows, just as text —
 * so CI, pipes, and anyone who opted out of whimsy get a script-safe,
 * unambiguous log instead of an Ink render.
 */
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import {
  runInit,
  type InitOptions,
  type InitResult,
  type InitProgressEvent,
} from "../commands/init-engine.js";
import { InitAnimationApp } from "./init-animation-app.js";
import { getMotionMode } from "../lib/config.js";

function plainLine(e: InitProgressEvent): string | null {
  switch (e.phase) {
    case "settings":
      return e.status === "start" ? "Scaffolding settings…" : null;
    case "graph":
      if (e.status === "start") return "Building code graph…";
      if (e.status === "done") return `Code graph: ${e.stats.files} files, ${e.stats.totalSymbols} symbols`;
      return null;
    case "domains":
      if (e.status === "start") return "Inferring domains…";
      if (e.status === "done") return `Domains: ${e.domains.length} found`;
      if (e.status === "skipped") return "Domains: skipped";
      return null;
    case "link":
      return e.status === "start" ? "Linking workspace…" : null;
    default:
      return null;
  }
}

function shouldAnimate(opts: InitOptions): boolean {
  if (opts.json) return false;
  if (!process.stdout.isTTY) return false;
  // /motion reduced|off kills the easter-egg game; getMotionMode also maps the
  // legacy OXAGEN_CLI_FUN=0 opt-out to "reduced", preserving that contract.
  if (getMotionMode() !== "full") return false;
  return true;
}

export async function runInitWithAnimation(opts: InitOptions): Promise<InitResult> {
  if (!shouldAnimate(opts)) {
    return runInit({
      ...opts,
      onProgress: (e) => {
        const line = plainLine(e);
        if (line) process.stderr.write(`${line}\n`);
      },
    });
  }

  const emitter = new EventEmitter();
  emitter.setMaxListeners(16);

  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const { unmount, waitUntilExit } = render(
    <InitAnimationApp
      emitter={emitter}
      onReady={() => readyResolve()}
      width={process.stdout.columns ?? 80}
    />,
  );

  const teardown = async (): Promise<void> => {
    unmount();
    await waitUntilExit();
  };

  try {
    return await runInit({
      ...opts,
      onProgress: async (e) => {
        emitter.emit("progress", e);
        // The domain-inference boundary is where init's real background work
        // (settings + code graph + domains) ends. Block right here until the
        // OXAGEN reveal has played and Ink has unmounted, so the (possibly
        // interactive) workspace-linker step that may run next never
        // interleaves its plain stdout writes with Ink's.
        if (e.phase === "domains" && e.status !== "start") {
          await ready;
          await teardown();
        }
      },
    });
  } catch (err) {
    // An error before reaching the domains boundary (e.g. the settings
    // scaffold failing) would otherwise leave the terminal stuck mid-
    // animation — tear down immediately rather than waiting on a reveal that
    // will never be triggered.
    await teardown();
    throw err;
  }
}
