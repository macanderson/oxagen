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
 */
import { createRequire } from "node:module";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { parseModeArg, type PermissionMode } from "./agent/permissions.js";

// The Oxagen context engine pulls in DuckDB, a native CommonJS dependency that
// references a bare `require`. Under pure-ESM execution that global is absent, so
// loading the store throws "require is not defined". Provide the shim before any
// code path dynamically imports the context engine.
{
  const g = globalThis as { require?: unknown };
  if (typeof g.require === "undefined") g.require = createRequire(import.meta.url);
}

const { version } = pkg;

const program = new Command();

program
  .name("oxagen")
  .description("Agentic coding assistant — powered by the Oxagen context engine")
  .version(version)
  .argument("[prompt...]", "One-shot prompt (runs and exits)")
  .option("-m, --model <slug>", "Gateway model slug (overrides config/default)")
  .option("--agent <name>", "Run the one-shot prompt as a named agent definition")
  .option(
    "--readonly",
    "Read-only mode: read/search/explain only — no file edits or commands",
    false,
  )
  .option(
    "--mode <mode>",
    "Permission mode: ask | accept-edits | bypass | readonly (REPL default: ask; one-shot ungated unless set)",
  )
  .option(
    "--no-pipeline",
    "Skip prompt evaluation, context injection, and completeness judging",
  )
  .option(
    "--verbose",
    "Capture + emit full per-turn telemetry (per-phase timing, model+token+cost, tool results)",
    false,
  )
  .action(
    async (
      promptWords: string[],
      opts: {
        model?: string;
        readonly?: boolean;
        mode?: string;
        pipeline?: boolean;
        verbose?: boolean;
        agent?: string;
      },
    ) => {
      const prompt = promptWords.join(" ").trim();
      let mode: PermissionMode | undefined;
      if (opts.mode) {
        mode = parseModeArg(opts.mode);
        if (!mode) {
          process.stderr.write(
            `Error: invalid --mode "${opts.mode}". Use ask, accept-edits, bypass, or readonly.\n`,
          );
          process.exitCode = 1;
          return;
        }
      }
      const runOpts = {
        model: opts.model,
        readOnly: opts.readonly,
        mode,
        bare: opts.pipeline === false,
        verbose: opts.verbose,
      };

      // --agent: run the prompt as a named agent (its prompt, tools, model).
      if (opts.agent) {
        if (!prompt) {
          process.stderr.write("Error: --agent requires a prompt, e.g. `oxagen --agent reviewer \"…\"`.\n");
          process.exitCode = 1;
          return;
        }
        const { runAgentOneShot } = await import("./repl/one-shot.js");
        await runAgentOneShot(prompt, opts.agent, runOpts);
        return;
      }

      if (prompt) {
        // One-shot mode: run prompt, stream response, exit
        const { runOneShot } = await import("./repl/one-shot.js");
        await runOneShot(prompt, runOpts);
      } else if (process.stdout.isTTY) {
        // Interactive REPL mode
        const { launchRepl } = await import("./repl/interactive.js");
        await launchRepl(runOpts);
      } else {
        // Piped input — read from stdin
        const { runFromStdin } = await import("./repl/one-shot.js");
        await runFromStdin(runOpts);
      }
    },
  );

// ── view: agent dashboard ─────────────────────────────────────────────────────

program
  .command("view")
  .description("Launch the agent dashboard (memory, compile, sessions)")
  .action(async () => {
    const { launchAgentView } = await import("./tui/agent-view/index.js");
    launchAgentView();
  });

// ── agents: the agents screen (fleet) ─────────────────────────────────────────

program
  .command("agents")
  .description("Launch the agents screen — plan a goal, dispatch a fleet, watch it work")
  .argument("[goal...]", "Goal to plan into tasks and run immediately")
  .option("--concurrency <n>", "Max agents running at once", (v) => parseInt(v, 10), 4)
  .option(
    "--readonly",
    "Read-only agents: read/search/explain only — no file edits or commands",
    false,
  )
  .option(
    "--isolate",
    "Run each agent in its own git worktree; commit + merge work back (no clobbering)",
    false,
  )
  .action(
    async (goal: string[], opts: { concurrency: number; readonly: boolean; isolate: boolean }) => {
      const { launchFleetView } = await import("./tui/fleet-view/index.js");
      await launchFleetView({
        cwd: process.cwd(),
        goal: goal.join(" ").trim() || undefined,
        concurrency: opts.concurrency,
        readOnly: opts.readonly,
        isolate: opts.isolate,
      });
    },
  );

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

// ── replay: inspect how a past turn was handled ───────────────────────────────

program
  .command("replay")
  .description("Show how a past turn was handled (prompt, scores, context, model, judge)")
  .argument("[turn]", "Turn index (1 = most recent) or id; omit for the latest")
  .option("--list", "List recent turns instead of replaying one", false)
  .action(async (turn: string | undefined, opts: { list?: boolean }) => {
    const { handleReplay } = await import("./commands/replay.js");
    await handleReplay(turn, opts);
  });

// ── cost: project + report model cost from the baked-in rate card ─────────────

program
  .command("cost")
  // The root's global `-m, --model` is reused (commander binds it to the parent),
  // so the action reads merged opts via optsWithGlobals() to see --model here.
  .description("Project model cost from the baked-in rate card, or roll up this project's spend")
  .option("--in <tokens>", "Input token count to price", (v) => parseInt(v, 10))
  .option("--out <tokens>", "Output token count to price", (v) => parseInt(v, 10))
  .option("--rates", "Print the baked-in rate card", false)
  .option("--session", "Roll up what this project's recorded turns actually cost, by model", false)
  .option("--json", "Output JSON", false)
  .action(async (_opts, command: Command) => {
    const merged = command.optsWithGlobals() as {
      in?: number;
      out?: number;
      model?: string;
      rates?: boolean;
      session?: boolean;
      json?: boolean;
    };
    const { handleCost } = await import("./commands/cost.js");
    await handleCost(merged);
  });

// ── graph: knowledge-graph search + pull + status ─────────────────────────────

const graph = program.command("graph").description("Query the knowledge graph");
graph
  .command("search")
  .description("Unified semantic (vector) search across the entire knowledge graph")
  .requiredOption("-q, --query <text>", "Natural-language query to search by vector similarity")
  .option(
    "-k, --kinds <kinds>",
    "Comma-separated node kinds (entity,file,symbol,chunk,memory,execution,document,message)",
  )
  .option("-l, --labels <labels>", "Comma-separated domain labels (e.g. Person,SourceFile)")
  .option("-n, --limit <n>", "Maximum number of results (1–50)", "10")
  .option("--system", "Only return product-owned (system) nodes")
  .option("--no-system", "Only return customer nodes (exclude system nodes)")
  .action(
    async (opts: {
      query: string;
      kinds?: string;
      labels?: string;
      limit?: string;
      system?: boolean;
    }) => {
      const { handleGraphSearch } = await import("./commands/graph.search.js");
      await handleGraphSearch(opts);
    },
  );

graph
  .command("pull")
  .description(
    "Download an incremental snapshot of the workspace graph into a local DuckDB replica",
  )
  .option("--full", "Ignore the saved cursor and re-pull the entire graph", false)
  .option(
    "-l, --labels <csv>",
    "Comma-separated domain labels to filter (e.g. Person,SourceFile)",
  )
  .option("--no-system", "Exclude product-owned (system) nodes")
  .option("--json", "Output summary as JSON")
  .action(
    async (opts: {
      full?: boolean;
      labels?: string;
      system?: boolean;
      json?: boolean;
    }) => {
      const { handleGraphPull } = await import("./commands/graph.pull.js");
      await handleGraphPull({
        full: opts.full,
        labels: opts.labels,
        noSystem: opts.system === false,
        json: opts.json,
      });
    },
  );

graph
  .command("status")
  .description("Show the state of the local workspace-graph replica")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { handleGraphStatus } = await import("./commands/graph.status.js");
    await handleGraphStatus(opts);
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

// ── settings: the unified settings.json driver ────────────────────────────────

const settings = program
  .command("settings")
  .description("Inspect and edit the unified settings.json (model, env, permissions, hooks, MCP)")
  .action(async () => {
    const { settingsShow } = await import("./commands/settings.js");
    settingsShow();
  });
settings
  .command("show")
  .description("Show the merged settings and which scope each file lives in")
  .action(async () => {
    const { settingsShow } = await import("./commands/settings.js");
    settingsShow();
  });
settings
  .command("path")
  .description("List the three scope files (user / project / local) and their status")
  .action(async () => {
    const { settingsPath } = await import("./commands/settings.js");
    settingsPath();
  });
settings
  .command("get")
  .description("Print a value by dotted key (e.g. permissions.defaultMode)")
  .argument("<key>", "Dotted settings key")
  .action(async (key: string) => {
    const { settingsGet } = await import("./commands/settings.js");
    settingsGet(key);
  });
settings
  .command("set")
  .description("Set a value (model | apiUrl | env.NAME) in a scope")
  .argument("<key>", "model, apiUrl, or env.NAME")
  .argument("<value>", "Value to write")
  .option("--scope <scope>", "user | project | local (default: project)")
  .action(async (key: string, value: string, opts: { scope?: string }) => {
    const { settingsSet } = await import("./commands/settings.js");
    settingsSet(key, value, opts.scope);
  });
settings
  .command("validate")
  .description("Validate every scope file against the settings schema")
  .action(async () => {
    const { settingsValidate } = await import("./commands/settings.js");
    settingsValidate();
  });
settings
  .command("init")
  .description("Write a documented starter settings.json (default: project scope)")
  .option("--scope <scope>", "user | project | local (default: project)")
  .action(async (opts: { scope?: string }) => {
    const { settingsInit } = await import("./commands/settings.js");
    settingsInit(opts.scope);
  });

// ── agent: named agent definitions ────────────────────────────────────────────

const agent = program
  .command("agent")
  .description("Manage named agent definitions (run one with `oxagen --agent <name> \"…\"`)");
agent
  .command("list")
  .description("List available agents")
  .action(async () => {
    const { agentList } = await import("./commands/agent.js");
    agentList();
  });
agent
  .command("show")
  .description("Show an agent's definition and system prompt")
  .argument("<name>", "Agent name")
  .action(async (name: string) => {
    const { agentShow } = await import("./commands/agent.js");
    agentShow(name);
  });
agent
  .command("new")
  .description("Scaffold a new agent at .oxagen/agents/<name>.md")
  .argument("<name>", "Agent name")
  .action(async (name: string) => {
    const { agentNew } = await import("./commands/agent.js");
    agentNew(name);
  });

// ── command: user-defined slash commands ──────────────────────────────────────

const command = program
  .command("command")
  .description("Manage user-defined slash commands (invoke as `/name` in the REPL)");
command
  .command("list")
  .description("List available slash commands")
  .action(async () => {
    const { commandList } = await import("./commands/command.js");
    commandList();
  });
command
  .command("show")
  .description("Show a slash command's template")
  .argument("<name>", "Command name")
  .action(async (name: string) => {
    const { commandShow } = await import("./commands/command.js");
    commandShow(name);
  });
command
  .command("new")
  .description("Scaffold a new slash command at .oxagen/commands/<name>.md")
  .argument("<name>", "Command name")
  .action(async (name: string) => {
    const { commandNew } = await import("./commands/command.js");
    commandNew(name);
  });
command
  .command("run")
  .description("Expand a slash command's template with args and run it as a turn")
  .argument("<name>", "Command name")
  .argument("[args...]", "Arguments substituted into the template")
  .action(async (name: string, args: string[]) => {
    const { commandRun } = await import("./commands/command.js");
    await commandRun(name, args ?? []);
  });

// ── rules: workspace rules the agent must follow ──────────────────────────────

const rules = program
  .command("rules")
  .description("Manage workspace rules the agent is told about and hard-blocked from violating");
rules
  .command("list")
  .description("List rules (and which are hard-enforced)")
  .action(async () => {
    const { rulesList } = await import("./commands/rules.js");
    rulesList();
  });
rules
  .command("show")
  .description("Show a rule's text and guard")
  .argument("<name>", "Rule name")
  .action(async (name: string) => {
    const { rulesShow } = await import("./commands/rules.js");
    rulesShow(name);
  });
rules
  .command("new")
  .description("Scaffold a new rule at .oxagen/rules/<name>.md")
  .argument("<name>", "Rule name")
  .action(async (name: string) => {
    const { rulesNew } = await import("./commands/rules.js");
    rulesNew(name);
  });
rules
  .command("check")
  .description("Dry-run a proposed tool call against the guards (bash|edit|write|read)")
  .argument("<tool>", "bash | edit | write | read")
  .argument("<subject>", "The command (bash) or path (edit/write/read) to test")
  .action(async (tool: string, subject: string) => {
    const { rulesCheck } = await import("./commands/rules.js");
    rulesCheck(tool, subject);
  });

// ── mcp: external MCP servers ─────────────────────────────────────────────────

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

const mcp = program
  .command("mcp")
  .description("Manage external MCP servers the agent loop connects to");
mcp
  .command("add")
  .description("Add an MCP server (stdio via --command, or http/sse/websocket via --url)")
  .argument("<name>", "Server name (used in tool names: mcp__<name>__<tool>)")
  .option("--command <command>", "stdio: the command to spawn (e.g. npx)")
  .option("--arg <arg>", "stdio: a command argument (repeatable)", collect, [])
  .option("--url <url>", "http/sse/websocket: the server URL")
  .option("--transport <transport>", "streamable-http | sse | websocket (default streamable-http)")
  .option("--auth <auth>", "none | bearer | header (default none)")
  .option("--env-token <VAR>", "Env var holding the bearer token")
  .option("--header <KEY=VALUE>", "Static header for header auth (repeatable)", collect, [])
  .option("--scope <scope>", "user | project | local (default project)")
  .action(async (name: string, opts: Record<string, unknown>) => {
    const { mcpAdd } = await import("./commands/mcp.js");
    mcpAdd(name, {
      command: opts["command"] as string | undefined,
      arg: opts["arg"] as string[] | undefined,
      url: opts["url"] as string | undefined,
      transport: opts["transport"] as string | undefined,
      auth: opts["auth"] as string | undefined,
      envToken: opts["envToken"] as string | undefined,
      header: opts["header"] as string[] | undefined,
      scope: opts["scope"] as string | undefined,
    });
  });
mcp
  .command("list")
  .description("List configured MCP servers")
  .action(async () => {
    const { mcpList } = await import("./commands/mcp.js");
    mcpList();
  });
mcp
  .command("remove")
  .description("Remove an MCP server")
  .argument("<name>", "Server name")
  .option("--scope <scope>", "Limit to a scope (default: auto-detect)")
  .action(async (name: string, opts: { scope?: string }) => {
    const { mcpRemove } = await import("./commands/mcp.js");
    mcpRemove(name, opts.scope);
  });
mcp
  .command("enable")
  .description("Enable a disabled MCP server")
  .argument("<name>", "Server name")
  .option("--scope <scope>", "Limit to a scope (default: auto-detect)")
  .action(async (name: string, opts: { scope?: string }) => {
    const { mcpSetEnabled } = await import("./commands/mcp.js");
    mcpSetEnabled(name, true, opts.scope);
  });
mcp
  .command("disable")
  .description("Disable an MCP server without removing it")
  .argument("<name>", "Server name")
  .option("--scope <scope>", "Limit to a scope (default: auto-detect)")
  .action(async (name: string, opts: { scope?: string }) => {
    const { mcpSetEnabled } = await import("./commands/mcp.js");
    mcpSetEnabled(name, false, opts.scope);
  });
mcp
  .command("check")
  .description("Connect to a server (or all enabled) and preview the tools it exposes")
  .argument("[name]", "Server name (omit to check all enabled)")
  .action(async (name: string | undefined) => {
    const { mcpCheck } = await import("./commands/mcp.js");
    await mcpCheck(name);
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
  // Project settings.json (env, apiUrl, model) into the environment before any
  // command runs — filling only unset vars, so the shell always wins.
  const { applySettingsToEnv } = await import("./settings/runtime.js");
  applySettingsToEnv();
  await program.parseAsync(process.argv);
}

void main();
