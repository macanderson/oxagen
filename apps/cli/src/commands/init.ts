/**
 * `oxagen init` — scaffold project + global settings, build the code graph,
 * link the project to an Oxagen workspace, and optionally connect GitHub.
 *
 * This module is the COMMAND HANDLER only. All of init's real work — settings
 * scaffolding, code-graph build, domain inference, and the workspace linker —
 * lives in the side-effect-free engine leaf, ./init-engine.ts. The engine's
 * public API (runInit, ensureSettingsFiles, formatInitSummary, and the Init*
 * types) is re-exported below so existing importers can keep importing from
 * "./init.js" unchanged.
 */
export * from "./init-engine.js";

import { formatInitSummary, type InitOptions } from "./init-engine.js";

// ---------------------------------------------------------------------------
// CLI handler (writes to stdout)
// ---------------------------------------------------------------------------

export async function handleInit(opts: InitOptions): Promise<void> {
  process.stderr.write("Initializing…\n");

  const { runInit } = await import("./init-engine.js");
  const result = await runInit(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatInitSummary(result) + "\n");
}
