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
  // command runs — filling only unset vars, so the shell always wins. This is
  // also what lets `OXAGEN_CLI_DEBUG=1` be enabled from settings.json `env`.
  const { applySettingsToEnv } = await import("./settings/runtime.js");
  applySettingsToEnv();
  // Silence the benign "responseFormat not supported" AI SDK warning emitted by
  // every generateObject call routed through the platform proxy (which handles
  // JSON via prompt fallback, not schema response_format). Must run before any
  // model call. See lib/ai-warnings.ts for why the fallback is correct by design.
  const { installAiSdkWarningFilter } = await import("./lib/ai-warnings.js");
  installAiSdkWarningFilter();
  // When OXAGEN_CLI_DEBUG=1, record the invocation to ~/.oxagen/logs/cli.output
  // before dispatching. Fire-and-forget: never blocks or breaks a command.
  const { debugLog } = await import("./lib/debug-log.js");
  void debugLog("invoke", "cli.start", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
  });
  await buildProgram().parseAsync(process.argv);
}

void main();
