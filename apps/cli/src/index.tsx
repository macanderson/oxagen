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

// ── env: workspace environments ───────────────────────────────────────────────

const env = program.command("env").description("Manage workspace environments");
env
  .command("list")
  .description("List environments in the active workspace")
  .option("--json", "Output JSON")
  .action(async (opts: { json?: boolean }) => {
    const { handleEnvList } = await import("./commands/env.js");
    await handleEnvList(opts);
  });
env
  .command("get")
  .description("Show one environment")
  .argument("<idOrSlug>", "Environment public id or slug")
  .action(async (idOrSlug: string) => {
    const { handleEnvGet } = await import("./commands/env.js");
    await handleEnvGet(idOrSlug, {});
  });
env
  .command("create")
  .description("Create an environment")
  .argument("<name>", "Display name")
  .option("--slug <slug>", "Slug (defaults to a slugified name)")
  .option("--description <text>", "Description")
  .action(async (name: string, opts: { slug?: string; description?: string }) => {
    const { handleEnvCreate } = await import("./commands/env.js");
    await handleEnvCreate(name, opts);
  });
env
  .command("update")
  .description("Update an environment")
  .argument("<idOrSlug>", "Environment public id or slug")
  .option("--name <name>", "New display name")
  .option("--slug <slug>", "New slug")
  .option("--description <text>", "New description")
  .option("--active", "Activate")
  .option("--inactive", "Deactivate (not allowed on the default)")
  .action(
    async (
      idOrSlug: string,
      opts: { name?: string; slug?: string; description?: string; active?: boolean; inactive?: boolean },
    ) => {
      const { handleEnvUpdate } = await import("./commands/env.js");
      const active = opts.active ? true : opts.inactive ? false : undefined;
      await handleEnvUpdate(idOrSlug, {
        name: opts.name,
        slug: opts.slug,
        description: opts.description,
        active,
      });
    },
  );
env
  .command("rm")
  .description("Delete an environment (not the default)")
  .argument("<idOrSlug>", "Environment public id or slug")
  .action(async (idOrSlug: string) => {
    const { handleEnvRemove } = await import("./commands/env.js");
    await handleEnvRemove(idOrSlug);
  });
env
  .command("set-default")
  .description("Promote an environment to the workspace default")
  .argument("<idOrSlug>", "Environment public id or slug")
  .action(async (idOrSlug: string) => {
    const { handleEnvSetDefault } = await import("./commands/env.js");
    await handleEnvSetDefault(idOrSlug);
  });

// ── secret: credential vault ──────────────────────────────────────────────────

const secret = program.command("secret").description("Manage the workspace credential vault");
secret
  .command("list")
  .description("List vault keys (masked metadata)")
  .option("--json", "Output JSON")
  .action(async (opts: { json?: boolean }) => {
    const { handleSecretList } = await import("./commands/secret.js");
    await handleSecretList(opts);
  });
secret
  .command("set")
  .description("Set a secret's default value, or an override with --env")
  .argument("<key>", "Secret key name")
  .argument("<value>", "Value")
  .option("--env <slug>", "Target environment (override); omit for the default value")
  .option("--no-sensitive", "Store as plaintext config (default: sensitive/encrypted)")
  .action(async (key: string, value: string, opts: { env?: string; sensitive?: boolean }) => {
    const { handleSecretSet } = await import("./commands/secret.js");
    await handleSecretSet(key, value, opts);
  });
secret
  .command("rm")
  .description("Delete a key, or just an environment override with --env")
  .argument("<key>", "Secret key name")
  .option("--env <slug>", "Remove only this environment's override")
  .action(async (key: string, opts: { env?: string }) => {
    const { handleSecretRemove } = await import("./commands/secret.js");
    await handleSecretRemove(key, opts);
  });
secret
  .command("reveal")
  .description("Reveal a secret's plaintext value (recorded to the access log)")
  .argument("<key>", "Secret key name")
  .option("--env <slug>", "Resolve for this environment")
  .action(async (key: string, opts: { env?: string }) => {
    const { handleSecretReveal } = await import("./commands/secret.js");
    await handleSecretReveal(key, opts);
  });
secret
  .command("import")
  .description("Import .env text (preview unless --yes)")
  .option("--env <slug>", "Target environment overrides; omit for default values")
  .option("-f, --file <path>", "Read from a file (else stdin)")
  .option("--yes", "Commit (otherwise preview only)")
  .action(async (opts: { env?: string; file?: string; yes?: boolean }) => {
    const { handleSecretImport } = await import("./commands/secret.js");
    await handleSecretImport(opts);
  });
secret
  .command("export")
  .description("Export resolved secrets as .env (recorded to the access log)")
  .option("--env <slug>", "Resolve for this environment")
  .option("-o, --out <path>", "Write to a file (else stdout)")
  .action(async (opts: { env?: string; out?: string }) => {
    const { handleSecretExport } = await import("./commands/secret.js");
    await handleSecretExport(opts);
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

void main();
