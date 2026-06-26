#!/usr/bin/env tsx
/**
 * oxagen — agentic coding CLI powered by the Engram context engine.
 *
 * Usage:
 *   oxagen                     Interactive REPL (default)
 *   oxagen "fix the login bug" One-shot prompt
 *   oxagen view                Agent dashboard (memory, compile, sessions)
 *   oxagen daemon start|stop|status
 *   oxagen config [key] [value]
 */
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

const { version } = pkg;

const program = new Command();

program
  .name("oxagen")
  .description("Agentic coding assistant — powered by Engram")
  .version(version)
  .argument("[prompt...]", "One-shot prompt (runs and exits)")
  .action(async (promptWords: string[]) => {
    const prompt = promptWords.join(" ").trim();

    if (prompt) {
      // One-shot mode: run prompt, stream response, exit
      const { runOneShot } = await import("./repl/one-shot.js");
      await runOneShot(prompt);
    } else if (process.stdout.isTTY) {
      // Interactive REPL mode
      const { launchRepl } = await import("./repl/interactive.js");
      await launchRepl();
    } else {
      // Piped input — read from stdin
      const { runFromStdin } = await import("./repl/one-shot.js");
      await runFromStdin();
    }
  });

// ── view: agent dashboard ─────────────────────────────────────────────────────

program
  .command("view")
  .description("Launch the agent dashboard (memory, compile, sessions)")
  .action(async () => {
    const { launchAgentView } = await import("./tui/agent-view/index.js");
    launchAgentView();
  });

// ── daemon: context daemon lifecycle ──────────────────────────────────────────

const daemon = program
  .command("daemon")
  .description("Manage the persistent context daemon");

daemon
  .command("start")
  .description("Start the context daemon (warm indexes, code graph)")
  .option("--foreground", "Run in foreground (don't daemonize)", false)
  .action(async (opts: { foreground: boolean }) => {
    const { startDaemon } = await import("./daemon/lifecycle.js");
    await startDaemon({ foreground: opts.foreground });
  });

daemon
  .command("stop")
  .description("Stop the running context daemon")
  .action(async () => {
    const { stopDaemon } = await import("./daemon/lifecycle.js");
    await stopDaemon();
  });

daemon
  .command("status")
  .description("Show daemon health and uptime")
  .action(async () => {
    const { daemonStatus } = await import("./daemon/lifecycle.js");
    await daemonStatus();
  });

// ── config: local configuration ───────────────────────────────────────────────

program
  .command("config")
  .description("View or set configuration (api key, model, etc.)")
  .argument("[key]", "Config key to get/set")
  .argument("[value]", "Value to set (omit to read)")
  .action(async (key?: string, value?: string) => {
    const { handleConfig } = await import("./commands/config.js");
    await handleConfig(key, value);
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

void main();
