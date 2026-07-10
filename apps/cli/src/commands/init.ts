/**
 * `oxagen init` — scaffold project + global settings, build the code graph,
 * link the project to an Oxagen workspace, and optionally connect GitHub.
 *
 * This module is the COMMAND HANDLER only. All of init's real work — settings
 * scaffolding, code-graph build, domain inference, and the workspace linker —
 * lives in the side-effect-free engine leaf, ./init-engine.ts, which imports no
 * TUI/Ink code. handleInit here lazy-loads the init animation, which itself
 * depends on the engine (not on this file), so there is no static import cycle.
 *
 * The engine's public API (runInit, ensureSettingsFiles, formatInitSummary, and
 * the Init* types) is re-exported below so existing importers — the REPL's
 * `/init`, unit tests, etc. — can keep importing from "./init.js" unchanged.
 */
export * from "./init-engine.js";

import { formatInitSummary, type InitOptions } from "./init-engine.js";

// ---------------------------------------------------------------------------
// CLI handler (writes to stdout)
// ---------------------------------------------------------------------------

export async function handleInit(opts: InitOptions): Promise<void> {
  process.stderr.write("Initializing…\n");

  // Dynamically imported (mirrors how program.tsx lazy-loads every command
  // module) so a plain `runInit()` caller — the REPL's `/init`, and the
  // engine's own unit tests — never pulls in Ink/React at all. The animation
  // module (tui/init-animation.tsx) imports the init engine directly from
  // ./init-engine.js, not from this handler, so there is no static import
  // cycle between this file and the animation it loads here.
  const { runInitWithAnimation } = await import("../tui/init-animation.js");
  const result = await runInitWithAnimation(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatInitSummary(result) + "\n");
}
