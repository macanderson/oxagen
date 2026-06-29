#!/usr/bin/env tsx
/**
 * oxagen — agentic coding CLI powered by the Oxagen context engine.
 *
 * Usage:
 *   oxagen                     Interactive REPL (default)
 *   oxagen "fix the login bug" One-shot prompt
 *   oxagen agents [goal...]    Agents screen — plan, dispatch & watch a fleet
 *   oxagen view                Agent dashboard (memory, compile, sessions)
 *   oxagen daemon start|stop|status
 *   oxagen config [key] [value]
 *
 * The Commander command tree lives in ./program.tsx so the REPL's slash-command
 * menu can introspect the exact same command set without re-running anything.
 * This entry stays thin: shim, settings projection, then hand off to the tree.
 */
import { createRequire } from "node:module";
import { buildProgram } from "./program.js";

// The Oxagen context engine pulls in DuckDB, a native CommonJS dependency that
// references a bare `require`. Under pure-ESM execution that global is absent, so
// loading the store throws "require is not defined". Provide the shim before any
// code path dynamically imports the context engine.
{
  const g = globalThis as { require?: unknown };
  if (typeof g.require === "undefined") g.require = createRequire(import.meta.url);
}

async function main(): Promise<void> {
  // Project settings.json (env, apiUrl, model) into the environment before any
  // command runs — filling only unset vars, so the shell always wins.
  const { applySettingsToEnv } = await import("./settings/runtime.js");
  applySettingsToEnv();
  await buildProgram().parseAsync(process.argv);
}

void main();
