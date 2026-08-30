#!/usr/bin/env tsx
/**
 * oxagen — agentic coding CLI powered by the Oxagen context engine.
 *
 * Usage:
 *   oxagen                     Interactive REPL (default)
 *   oxagen "fix the login bug" One-shot prompt
 *   oxagen agents [goal...]    Agents screen — plan, dispatch & watch a fleet
 *   oxagen view                Audit agent work — runs, cost, code-graph, health
 *   oxagen daemon start|stop|status
 *   oxagen config [key] [value]
 *
 * The Commander command tree lives in ./program.tsx so the REPL's slash-command
 * menu can introspect the exact same command set without re-running anything.
 * This entry stays thin: shim, settings projection, then hand off to the tree.
 */
import { createRequire } from "node:module";
import { buildProgram } from "./program.js";
import { debugLog, isDebugEnabled } from "./lib/debug-log.js";
import { formatFatalError } from "./lib/fatal-error.js";

// The Oxagen context engine pulls in DuckDB, a native CommonJS dependency that
// references a bare `require`. Under pure-ESM execution that global is absent, so
// loading the store throws "require is not defined". Provide the shim before any
// code path dynamically imports the context engine.
{
  const g = globalThis as { require?: unknown };
  if (typeof g.require === "undefined")
    g.require = createRequire(import.meta.url);
}

// Top-level safety net. Without this, a common file error (e.g.
// `oxagen code diff missing.txt`) prints a raw Node stack trace. Instead, write a
// single clean `Error: <message>` line to stderr — the full stack only under
// OXAGEN_CLI_DEBUG — best-effort log it, and exit non-zero. Registered before
// main() so it also covers failures during command construction.
function reportFatal(err: unknown): void {
  process.stderr.write(formatFatalError(err, isDebugEnabled()));
  void debugLog("error", "cli.fatal", err);
}

process.on("unhandledRejection", (reason) => {
  reportFatal(reason);
  process.exitCode = 1;
});

process.on("uncaughtException", (err) => {
  reportFatal(err);
  // An uncaught exception leaves the process in an undefined state — exit now.
  // The debugLog above is fire-and-forget and may not flush; that is acceptable.
  process.exit(1);
});

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
  void debugLog("invoke", "cli.start", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
  });

  // Anonymous usage telemetry (TELEMETRY.md) — one event per invocation,
  // emitted after the command finishes whether it succeeded or failed.
  // `recordUsageEvent` can never throw or add meaningful latency (opt-out
  // check is synchronous; the network send has its own bounded timeout and
  // swallows every failure), so wrapping the whole program in try/finally
  // here is safe and keeps every command instrumented from one place.
  const program = buildProgram();
  const knownCommands = program.commands.map((cmd) => cmd.name());
  const { classifyCommand, classifyErrorType, recordUsageEvent } = await import(
    "./telemetry/usage.js"
  );
  const command = classifyCommand(process.argv, knownCommands);
  const startedAt = Date.now();
  let errorType = "";
  let exitStatus = "success";
  try {
    await program.parseAsync(process.argv);
    if (process.exitCode) exitStatus = "error";
  } catch (err) {
    exitStatus = "error";
    errorType = classifyErrorType(err);
    throw err;
  } finally {
    await recordUsageEvent({
      command,
      durationMs: Date.now() - startedAt,
      exitStatus,
      errorType,
    });
  }
}

main().catch((err) => {
  reportFatal(err);
  process.exitCode = 1;
});
