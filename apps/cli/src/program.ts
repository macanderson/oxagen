/**
 * program.ts — The Commander command tree for the `oxagen` CLI.
 *
 * Extracted from index.ts so the exact same command set that drives
 * `oxagen --help` is the single source of truth for command introspection
 * (commands/meta.ts describeCliCommands). Building the program has no side
 * effects — every handler is a dynamic `import()` inside its action — so a
 * caller can construct it purely to introspect command names + descriptions
 * without running anything.
 *
 * Scope, after ADR-043: Oxagen governs, grounds, explains, meters/bills and
 * rates agents — it does not run them. So every command below is a governance
 * *operation* against the platform API: spend ceilings and cost, run traces,
 * graph grounding, agent memory, credentials and environments, audit logs,
 * workspace linking. The local coding agent (REPL, turns, sandboxes,
 * skills, slash commands, evals, local settings/rules) is gone; Stella owns it
 * and talks to Oxagen over MCP/API. Every removed entry point stays registered
 * as a stub (commands/retired.ts) so a stale invocation fails with guidance
 * instead of an unknown-command error.
 */
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { printRetiredNotice } from "./commands/retired.js";

const { version } = pkg;

/**
 * Construct the full `oxagen` command tree. Pure: no parsing, no I/O, no
 * side effects — `index.ts` parses it, the REPL only introspects it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("oxagen")
    .description(
      "Oxagen governance CLI — spend, traces, grounding, credentials, and audit",
    )
    .version(version)
    .argument("[prompt...]", "(retired) agent turns moved to the `stella` CLI")
    .allowExcessArguments(true)
    // Kept for subcommands that read merged globals via optsWithGlobals()
    // (`cost -m <slug>` prices a model from the rate card).
    .option(
      "-m, --model <slug>",
      "Model slug for subcommands that price or filter by model (e.g. cost)",
    )
    .action(async () => {
      // The interactive REPL and one-shot agent turns were retired in the
      // Stella cutover; only the platform subcommands remain.
      printRetiredNotice("The oxagen coding agent (REPL / one-shot prompt)");
    });

  /**
   * Register a retired command: same name, no behavior — one shared notice
   * pointing at the `stella` CLI. Accepts and ignores whatever arguments/flags
   * the old command took so stale scripts fail with guidance rather than a
   * Commander parse error.
   */
  function retiredCommand(name: string, what: string): void {
    program
      .command(name)
      .description(`(retired) ${what} — use the \`stella\` CLI`)
      .argument("[args...]")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(async () => {
        printRetiredNotice(what);
      });
  }

  // Retired with the interactive coding agent (the Stella cutover).
  retiredCommand("view", "The agent-work dashboard");
  retiredCommand("agents", "The fleet agents screen");
  retiredCommand("solve", "Best-of-N task solving");
  retiredCommand("daemon", "The local context daemon");
  retiredCommand("replay", "Local turn replay");
  retiredCommand("fleet", "The session fleet");

  // Retired with the agent runtime (ADR-043). Grouped by what they ran:
  // execution surfaces, local authoring surfaces, and repo/CI automation.
  retiredCommand("sandbox", "Agent sandbox sessions");
  retiredCommand("sandbox-template", "Sandbox template management");
  retiredCommand("code", "Local code diff/patch/format utilities");
  retiredCommand("eval", "Eval datasets and runs");
  retiredCommand("file-lock", "Agent file locks");
  retiredCommand("a2a", "The Agent2Agent protocol surface");
  retiredCommand("models", "On-device model runtime selection");
  retiredCommand("skill", "Loadable skill bundles");
  retiredCommand("prompt", "Saved prompt snippets");
  retiredCommand("command", "User-defined slash commands");
  retiredCommand("rules", "Local agent rule files");
  retiredCommand("settings", "The local settings.json driver");
  retiredCommand("config", "The local CLI config file");
  retiredCommand("mcp", "Local MCP server configuration");
  retiredCommand("import", "Foreign-platform artifact import");
  retiredCommand("pr", "Pull-request CI watching and merging");
  retiredCommand("recover", "Agent commit-ledger recovery");
  retiredCommand("lineage", "The subagent dispatch-tree explorer");

  // ── cost: project model cost from the baked-in rate card ────────────────────

  program
    .command("cost")
    // The root's global `-m, --model` is reused (commander binds it to the parent),
    // so the action reads merged opts via optsWithGlobals() to see --model here.
    .description(
      "Project model cost from the baked-in rate card (observed spend: `budget show`)",
    )
    .option("--in <tokens>", "Input token count to price", (v) =>
      parseInt(v, 10),
    )
    .option("--out <tokens>", "Output token count to price", (v) =>
      parseInt(v, 10),
    )
    .option("--rates", "Print the baked-in rate card", false)
    .option("--json", "Output JSON", false)
    .action(async (_opts, command: Command) => {
      const merged = command.optsWithGlobals() as {
        in?: number;
        out?: number;
        model?: string;
        rates?: boolean;
        json?: boolean;
      };
      const { handleCost } = await import("./commands/cost.js");
      handleCost(merged);
    });

  // ── budget: hard spend ceilings (get_spend_budget / set_spend_budget) ───────

  const budgetCmd = program
    .command("budget")
    .description(
      "Hard period-to-date spend ceilings that gate agent runs — org + workspace",
    );
  budgetCmd
    .command("show")
    .description("Show configured spend ceilings with their live burn")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { budgetShow } = await import("./commands/budget.js");
      await budgetShow(opts);
    });
  budgetCmd
    .command("set")
    .description(
      "Set (create or replace) a spend ceiling — Owner/Admin/Billing only",
    )
    .requiredOption("--scope <scope>", "org | workspace")
    .requiredOption("--period <period>", "monthly | rolling")
    .requiredOption("--limit <usd>", "Hard USD ceiling (> 0)")
    .option(
      "--window-days <n>",
      "Trailing window in days — required for --period rolling, omit for monthly",
    )
    .option(
      "--enabled <bool>",
      "Whether the ceiling is enforced (true/false)",
      "true",
    )
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        scope?: string;
        period?: string;
        limit?: string;
        windowDays?: string;
        enabled?: string;
        json?: boolean;
      }) => {
        const { budgetSet } = await import("./commands/budget.js");
        await budgetSet(opts);
      },
    );

  // ── trace: one agent run as a span tree ─────────────────────────────────────

  program
    .command("trace")
    .argument("<executionId>", "Public ID (aex_…) or UUID of the execution")
    .description(
      "Show an agent run as a span tree: steps, tool calls, and child executions",
    )
    .option("--json", "Output the raw trace as JSON", false)
    .action(async (executionId: string, opts: { json?: boolean }) => {
      const { handleTrace } = await import("./commands/trace.js");
      await handleTrace(executionId, opts);
    });

  // ── graph: knowledge-graph search + pull + status ───────────────────────────

  const graph = program
    .command("graph")
    .description("Query the knowledge graph");
  graph
    .command("search")
    .description("Semantic (vector) search across the customer context graph")
    .requiredOption(
      "-q, --query <text>",
      "Natural-language query to search by vector similarity",
    )
    .option(
      "-l, --labels <labels>",
      "Comma-separated domain labels (e.g. Person,Company)",
    )
    .option("-n, --limit <n>", "Maximum number of results (1–50)", "10")
    .option(
      "--json",
      "One machine JSON line (also the default when stdout is piped)",
      false,
    )
    .option("--quiet", "Suppress progress chrome (stderr)", false)
    .action(
      async (opts: {
        query: string;
        labels?: string;
        limit?: string;
        json?: boolean;
        quiet?: boolean;
      }) => {
        const { handleGraphSearch } = await import(
          "./commands/graph.search.js"
        );
        await handleGraphSearch(opts);
      },
    );

  // ── memory: manage the workspace's agent memories ───────────────────────────

  const memory = program
    .command("memory")
    .description(
      "Manage the workspace's agent memories (list, show, edit, salience, promote, candidates, rm)",
    );
  memory
    .command("list")
    .description(
      "List the workspace's memories, sorted by recency or citation count",
    )
    .option(
      "--class <memoryClass>",
      "Filter by epistemic class (OBSERVATION|RULE|FACT)",
    )
    .option(
      "--kind <kind>",
      "Filter by content-domain kind (e.g. FEEDBACK, PERFORMANCE, constraint, gotcha)",
    )
    .option(
      "--min-enforcement <n>",
      "Only rules at or above this enforcement score (1-100)",
    )
    .option(
      "--min-citations <n>",
      "Only memories cited at least this many times",
    )
    .option(
      "--sort <axis>",
      "Sort by 'createdAt' (recency, default) or 'citations'",
    )
    .option("--node <ref>", "Scope to memories anchored on a graph node ref")
    .option("--limit <n>", "Max rows (default 100)")
    .option("--offset <n>", "Skip N rows (paging)")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        class?: string;
        kind?: string;
        minEnforcement?: string;
        minCitations?: string;
        sort?: string;
        node?: string;
        limit?: string;
        offset?: string;
        json?: boolean;
      }) => {
        const { handleMemoryList } = await import("./commands/memory.js");
        await handleMemoryList(opts);
      },
    );
  memory
    .command("show <id>")
    .description("Show one memory in full detail (by id or publicId)")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const { handleMemoryShow } = await import("./commands/memory.js");
      await handleMemoryShow(id, opts);
    });
  memory
    .command("edit <id>")
    .description("Edit a memory's lesson, kind, or source")
    .option("--lesson <text>", "Replacement lesson text (re-embeds for recall)")
    .option("--kind <kind>", "New content-domain kind")
    .option("--source <source>", "New provenance label")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: {
          lesson?: string;
          kind?: string;
          source?: string;
          json?: boolean;
        },
      ) => {
        const { handleMemoryEdit } = await import("./commands/memory.js");
        await handleMemoryEdit(id, opts);
      },
    );
  memory
    .command("salience <id>")
    .description(
      "Adjust a memory's confidence/enforcement scores or lifecycle status (class changes go through `memory promote`)",
    )
    .option("--confidence <n>", "Numeric confidence 0–100")
    .option("--enforcement <n>", "Numeric enforcement 1–100 (for a RULE)")
    .option(
      "--status <status>",
      "Lifecycle status (ACTIVE|SUPERSEDED|RETRACTED|ARCHIVED)",
    )
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: {
          confidence?: string;
          enforcement?: string;
          status?: string;
          json?: boolean;
        },
      ) => {
        const { handleMemorySalience } = await import("./commands/memory.js");
        await handleMemorySalience(id, opts);
      },
    );
  memory
    .command("promote <id>")
    .description(
      "Promote a memory to RULE or FACT, recording an auditable promotion event (FACT requires human confirmation)",
    )
    .requiredOption("--to <class>", "Target class: rule|fact")
    .option(
      "--enforcement <n>",
      "Enforcement 1–100 to set for a RULE (ignored for FACT, forced 100)",
    )
    .option("--rationale <text>", "Optional: why this memory is being promoted")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: {
          to?: string;
          enforcement?: string;
          rationale?: string;
          json?: boolean;
        },
      ) => {
        const { handleMemoryPromote } = await import("./commands/memory.js");
        await handleMemoryPromote(id, opts);
      },
    );
  memory
    .command("demote <id>")
    .description(
      "Demote a memory to RULE or OBSERVATION, recording an auditable demotion event (target must be below the current class)",
    )
    .requiredOption("--to <class>", "Target class: rule|observation")
    .option(
      "--enforcement <n>",
      "Enforcement 1–100 to set when demoting to RULE (ignored for OBSERVATION, forced null)",
    )
    .option("--rationale <text>", "Optional: why this memory is being demoted")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: {
          to?: string;
          enforcement?: string;
          rationale?: string;
          json?: boolean;
        },
      ) => {
        const { handleMemoryDemote } = await import("./commands/memory.js");
        await handleMemoryDemote(id, opts);
      },
    );
  memory
    .command("dismiss <id>")
    .description(
      "Dismiss a memory from the promotion candidate queue (or restore it with --restore)",
    )
    .option("--restore", "Restore a previously dismissed memory to the queue")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { restore?: boolean; json?: boolean }) => {
      const { handleMemoryDismiss } = await import("./commands/memory.js");
      await handleMemoryDismiss(id, opts);
    });
  memory
    .command("candidates")
    .description(
      "List the top OBSERVATION memories by citation pressure ripe for promotion",
    )
    .option("--limit <n>", "Max candidates (default 3)")
    .option("--json", "Output JSON")
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const { handleMemoryCandidates } = await import("./commands/memory.js");
      await handleMemoryCandidates(opts);
    });
  memory
    .command("citations")
    .description(
      "Workspace citation analytics: totals, influence/compliance, most-cited / least-useful / most-violated memories and nodes",
    )
    .option("--days <n>", "Window in days (default 30)")
    .option("--limit <n>", "Max entries per top-N list (default 10)")
    .option("--json", "Output JSON")
    .action(async (opts: { days?: string; limit?: string; json?: boolean }) => {
      const { handleMemoryCitations } = await import("./commands/memory.js");
      await handleMemoryCitations(opts);
    });
  memory
    .command("rm <id>")
    .description("Permanently delete a memory by id")
    .action(async (id: string) => {
      const { handleMemoryRemove } = await import("./commands/memory.js");
      await handleMemoryRemove(id);
    });
  memory
    .command("import <files...>")
    .description(
      "Bulk-import markdown skill files / rule docs as memories (previews unless --yes)",
    )
    .option("--node <ref>", "Anchor every imported memory on a graph node ref")
    .option("-y, --yes", "Commit the parsed drafts (default previews only)")
    .option("--json", "Output JSON")
    .action(
      async (
        files: string[],
        opts: { node?: string; yes?: boolean; json?: boolean },
      ) => {
        const { handleMemoryImport } = await import("./commands/memory.js");
        await handleMemoryImport(files, opts);
      },
    );

  // ── remember: capture a memory (infers class + kind) ────────────────────────

  program
    .command("remember <text...>")
    .description(
      "Capture a memory — infers its class + kind and saves it to the workspace graph",
    )
    .option(
      "--class <memoryClass>",
      "Pin the epistemic class (OBSERVATION|RULE|FACT) instead of inferring it",
    )
    .option(
      "--kind <kind>",
      "Pin the content-domain kind instead of inferring it",
    )
    .option("--enforcement <n>", "Enforcement 1–100 when --class is RULE")
    .option("--node <ref>", "Anchor the memory on a graph node ref")
    .option("--json", "Output JSON")
    .action(
      async (
        text: string[],
        opts: {
          class?: string;
          kind?: string;
          enforcement?: string;
          node?: string;
          json?: boolean;
        },
      ) => {
        const { handleRemember } = await import("./commands/memory.js");
        await handleRemember(text.join(" "), opts);
      },
    );

  // ── asset: ingest a binary asset from a URL into object storage ──────────────

  const asset = program
    .command("asset")
    .description("Ingest and manage binary assets in object storage");

  asset
    .command("upload <url>")
    .description(
      "Ingest an asset from a public URL. With --conversation, records it as a " +
        "private chat attachment linked to that conversation.",
    )
    .option(
      "--kind <kind>",
      "Asset kind: avatar|image|document|video (default image)",
    )
    .option("--filename <name>", "Original filename (display only)")
    .option(
      "--conversation <id>",
      "Attach to a conversation (implies a user_upload)",
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        url: string,
        opts: {
          kind?: string;
          filename?: string;
          conversation?: string;
          json?: boolean;
        },
      ) => {
        const { handleAssetUpload } = await import("./commands/asset.js");
        await handleAssetUpload(url, opts);
      },
    );

  // ── conversation: export & inspect chat conversations ───────────────────────

  const conversation = program
    .command("conversation")
    .description("Export and inspect chat conversations");

  conversation
    .command("export <id>")
    .description(
      "Export a conversation's active branch as Markdown (stdout/file) or a " +
        "formatted PDF (stored privately; prints the serve URL).",
    )
    .option("--format <format>", "Export format: md|markdown|pdf (default md)")
    .option(
      "-o, --output <file>",
      "Write markdown output to a file instead of stdout",
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        id: string,
        opts: { format?: string; output?: string; json?: boolean },
      ) => {
        const { handleConversationExport } = await import(
          "./commands/conversation.js"
        );
        await handleConversationExport(id, opts);
      },
    );

  // ── init: link this project to an org + workspace ───────────────────────────

  program
    .command("init")
    .description(
      "Link this project to an Oxagen org + workspace (writes .oxagen/workspace.json)",
    )
    .option("--json", "Output JSON instead of human-readable text")
    .option("--no-link", "Skip the workspace linker step entirely")
    .action(async (opts: { json?: boolean; link?: boolean }) => {
      const { handleInit } = await import("./commands/init.js");
      await handleInit({ json: opts.json, noLink: opts.link === false });
    });

  // ── logs: see + debug the OXAGEN_CLI_DEBUG .output stream ────────────────────

  program
    .command("logs")
    .description(
      "See and debug the CLI's log (~/.oxagen/logs/cli.output). Captures invocations, " +
        "and LLM telemetry when OXAGEN_CLI_DEBUG=1.",
    )
    .option("--path", "Print the log file path and exit", false)
    .option("-n, --lines <n>", "Number of recent entries to show (default 50)")
    .option(
      "--category <category>",
      "Filter by category: invoke | api | llm | error",
    )
    .option("-f, --follow", "Follow the log live (like tail -f)", false)
    .option("--clear", "Truncate the log to empty and exit", false)
    .option("--json", "Emit raw JSONL instead of the formatted view", false)
    .action(
      async (opts: {
        path?: boolean;
        lines?: string;
        category?: string;
        follow?: boolean;
        clear?: boolean;
        json?: boolean;
      }) => {
        const { handleLogs } = await import("./commands/logs.js");
        await handleLogs(opts);
      },
    );

  // ── telemetry: anonymous usage-telemetry controls (TELEMETRY.md) ────────────

  program
    .command("telemetry")
    .description(
      "Inspect or control anonymous CLI usage telemetry (on by default — see TELEMETRY.md)",
    )
    .argument("[subcommand]", "on | off | status (default: status)")
    .action(async (subcommand?: string) => {
      const { handleTelemetry } = await import("./commands/telemetry.js");
      handleTelemetry(subcommand);
    });

  // ── tacho: put this machine's Claude Code sessions under Oxagen control ──────
  //
  // docs/specs/tacho/spec.md section 5.1. The work lives in @oxagen/tacho;
  // these commands lend it the CLI's credentials so `oxagen tacho enroll`
  // needs no --token after `oxagen login`.

  const tacho = program
    .command("tacho")
    .description(
      "Record and gate this machine's Claude Code sessions through Oxagen (Tacho)",
    );

  tacho
    .command("enroll")
    .description(
      "Enroll this machine: device key, host API key, tachod service, Claude Code hooks",
    )
    .option(
      "--token <apiKey>",
      "Platform API token (default: the logged-in session)",
    )
    .option("--org <slug>", "Organization slug (default: the logged-in org)")
    .option(
      "--workspace <slug>",
      "Workspace slug (default: the logged-in workspace)",
    )
    .option("--port <n>", "Loopback port for tachod", (v: string) => Number(v))
    .option("--no-service", "Do not install the user service")
    .option("--managed", "Also print the managed settings document for MDM")
    .option(
      "--print-managed",
      "Only print the managed settings document; do not write user settings",
    )
    .option("--force", "Enroll again even if already enrolled")
    .option("--verify", "Run a headless Claude Code turn afterwards")
    .action(
      async (opts: {
        token?: string;
        org?: string;
        workspace?: string;
        port?: number;
        service?: boolean;
        managed?: boolean;
        printManaged?: boolean;
        force?: boolean;
        verify?: boolean;
      }) => {
        const { handleTachoEnroll } = await import("./commands/tacho.js");
        if (!(await handleTachoEnroll(opts))) process.exitCode = 1;
      },
    );

  tacho
    .command("status")
    .description("Enrollment, daemon, hooks, bundle, and spool status")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const { handleTachoStatus } = await import("./commands/tacho.js");
      if (!(await handleTachoStatus(opts))) process.exitCode = 1;
    });

  tacho
    .command("unenroll")
    .description(
      "Remove the hooks and the service, revoke the enrollment, delete the host key",
    )
    .option("--token <apiKey>", "Operator token for the server-side revoke")
    .option("--purge", "Also delete the local WAL, spool, and quarantine")
    .option("--reason <text>", "Reason recorded with the revoke")
    .action(
      async (opts: { token?: string; purge?: boolean; reason?: string }) => {
        const { handleTachoUnenroll } = await import("./commands/tacho.js");
        if (!(await handleTachoUnenroll(opts))) process.exitCode = 1;
      },
    );

  tacho
    .command("export")
    .description("Export a session from the local WAL")
    .option("--session <id>", "Claude Code session id or Tacho session uuid")
    .option("--format <fmt>", "tacho | trace | otlp", "tacho")
    .option("--out <file>", "Write to a file instead of stdout")
    .option("--list", "List sessions in the WAL")
    .action(
      async (opts: {
        session?: string;
        format?: "tacho" | "trace" | "otlp";
        out?: string;
        list?: boolean;
      }) => {
        const { handleTachoExport } = await import("./commands/tacho.js");
        if (!(await handleTachoExport(opts))) process.exitCode = 1;
      },
    );

  tacho
    .command("verify")
    .description("Run one headless Claude Code turn and confirm it was chained")
    .action(async () => {
      const { handleTachoVerify } = await import("./commands/tacho.js");
      if (!(await handleTachoVerify())) process.exitCode = 1;
    });

  // ── login / logout: platform authentication ─────────────────────────────────

  program
    .command("login")
    .description(
      "Authenticate the CLI — opens a browser by default (interactive). Use --token for CI/headless.",
    )
    .option(
      "--token <token>",
      "Platform API token — skips browser login (CI/headless)",
    )
    .option("--org <slug>", "Organization slug (required with --token)")
    .option("--workspace <slug>", "Workspace slug (required with --token)")
    .option("--no-browser", "Prompt for token instead of opening the browser")
    .action(
      async (opts: {
        token?: string;
        org?: string;
        workspace?: string;
        browser?: boolean;
      }) => {
        const { handleLogin } = await import("./commands/auth.js");
        await handleLogin(opts);
      },
    );

  program
    .command("logout")
    .description(
      "Clear the stored Oxagen session from ~/.config/oxagen/config.json.",
    )
    .action(async () => {
      const { handleLogout } = await import("./commands/auth.js");
      handleLogout();
    });

  // ── agent env: bind agents to environments ──────────────────────────────────
  //
  // Server-scoped: the <agent> arg is an agent's public id (agt_…), slug, or
  // agent-key, resolved against the workspace's agent definitions. Environments
  // are governed configuration records — binding one does not run anything.

  const agent = program
    .command("agent")
    .description("Govern the workspace's registered agents");

  const agentEnv = agent
    .command("env")
    .description("Bind an agent to an environment");

  agentEnv
    .command("bind <agent>")
    .description(
      "Bind an agent to an environment (promotes to primary if it is the agent's first)",
    )
    .requiredOption("--env <slug>", "Environment to bind (slug or env_ id)")
    .option(
      "--primary",
      "Make this the agent's primary binding (atomically demotes the previous)",
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        agentHandle: string,
        opts: {
          env?: string;
          primary?: boolean;
          json?: boolean;
        },
      ) => {
        const { handleAgentEnvBind } = await import("./commands/agent-env.js");
        await handleAgentEnvBind(agentHandle, opts);
      },
    );

  agentEnv
    .command("unbind <agent>")
    .description("Remove an agent's binding to an environment")
    .requiredOption("--env <slug>", "Environment to unbind (slug or env_ id)")
    .option("--json", "Emit raw JSON output")
    .action(
      async (agentHandle: string, opts: { env?: string; json?: boolean }) => {
        const { handleAgentEnvUnbind } = await import(
          "./commands/agent-env.js"
        );
        await handleAgentEnvUnbind(agentHandle, opts);
      },
    );

  agentEnv
    .command("list <agent>")
    .description("List an agent's environment bindings")
    .option("--json", "Emit raw JSON output")
    .action(async (agentHandle: string, opts: { json?: boolean }) => {
      const { handleAgentEnvList } = await import("./commands/agent-env.js");
      await handleAgentEnvList(agentHandle, opts);
    });

  // ── env: workspace environments ─────────────────────────────────────────────

  const env = program
    .command("env")
    .description("Manage workspace environments");
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
    .action(
      async (name: string, opts: { slug?: string; description?: string }) => {
        const { handleEnvCreate } = await import("./commands/env.js");
        await handleEnvCreate(name, opts);
      },
    );
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
        opts: {
          name?: string;
          slug?: string;
          description?: string;
          active?: boolean;
          inactive?: boolean;
        },
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

  // ── router: Verified-Outcome Market Router ──────────────────────────────────

  const routerCmd = program
    .command("router")
    .description(
      "Verified-Outcome Market Router — learned, economic model routing",
    );
  routerCmd
    .command("stats")
    .description(
      "Observed outcomes per (task class, model) + cheapest-clearing model per class",
    )
    .option("--task-class <class>", "Restrict to one task class")
    .option("--window <days>", "Trailing window in days")
    .option("--min-samples <n>", "Minimum samples per (class, model)")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        taskClass?: string;
        window?: string;
        minSamples?: string;
        json?: boolean;
      }) => {
        const { routerStats } = await import("./commands/router.js");
        await routerStats({
          taskClass: opts.taskClass,
          window: opts.window ? Number(opts.window) : undefined,
          minSamples: opts.minSamples ? Number(opts.minSamples) : undefined,
          json: opts.json,
        });
      },
    );
  routerCmd
    .command("preview <prompt>")
    .description("Dry-run the routing decision for a prompt (changes nothing)")
    .option("--files <n>", "Expected number of files touched")
    .option("--cross-package", "The task crosses package boundaries")
    .option("--task-class <class>", "Override the derived task class")
    .option("--json", "Output JSON")
    .action(
      async (
        prompt: string,
        opts: {
          files?: string;
          crossPackage?: boolean;
          taskClass?: string;
          json?: boolean;
        },
      ) => {
        const { routerPreview } = await import("./commands/router.js");
        await routerPreview(prompt, {
          files: opts.files ? Number(opts.files) : undefined,
          crossPackage: opts.crossPackage,
          taskClass: opts.taskClass,
          json: opts.json,
        });
      },
    );
  const routerPolicyCmd = routerCmd
    .command("policy")
    .description("Get or set the governed market-router policy");
  routerPolicyCmd
    .command("get")
    .description("Show the effective policy and its provenance")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { routerPolicyGet } = await import("./commands/router.js");
      await routerPolicyGet(opts);
    });
  routerPolicyCmd
    .command("set")
    .description("Update the policy (org Owner/Admin) — changes spend behavior")
    .option("--scope <scope>", "org | workspace (default workspace)")
    .option("--mode <mode>", "off | shadow | enforce")
    .option("--threshold <n>", "Verified-success threshold 0..1 (e.g. 0.95)")
    .option("--min-samples <n>", "Minimum samples before a model is trusted")
    .option("--window <days>", "Trailing stats window in days")
    .option(
      "--escalate <bool>",
      "Escalate a tier on judge rejection (true/false)",
    )
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        scope?: string;
        mode?: string;
        threshold?: string;
        minSamples?: string;
        window?: string;
        escalate?: string;
        json?: boolean;
      }) => {
        const { routerPolicySet } = await import("./commands/router.js");
        await routerPolicySet({
          scope:
            opts.scope === "org"
              ? "org"
              : opts.scope === "workspace"
                ? "workspace"
                : undefined,
          mode:
            opts.mode === "off" ||
            opts.mode === "shadow" ||
            opts.mode === "enforce"
              ? opts.mode
              : undefined,
          threshold: opts.threshold ? Number(opts.threshold) : undefined,
          minSamples: opts.minSamples ? Number(opts.minSamples) : undefined,
          window: opts.window ? Number(opts.window) : undefined,
          escalate:
            opts.escalate === undefined
              ? undefined
              : opts.escalate === "true" || opts.escalate === "yes",
          json: opts.json,
        });
      },
    );

  // ── secret: credential vault ────────────────────────────────────────────────

  const secret = program
    .command("secret")
    .description("Manage the workspace credential vault");
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
    .option(
      "--env <slug>",
      "Target environment (override); omit for the default value",
    )
    .option(
      "--no-sensitive",
      "Store as plaintext config (default: sensitive/encrypted)",
    )
    .action(
      async (
        key: string,
        value: string,
        opts: { env?: string; sensitive?: boolean },
      ) => {
        const { handleSecretSet } = await import("./commands/secret.js");
        await handleSecretSet(key, value, opts);
      },
    );
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
    .description(
      "Reveal a secret's plaintext value (recorded to the access log)",
    )
    .argument("<key>", "Secret key name")
    .option("--env <slug>", "Resolve for this environment")
    .action(async (key: string, opts: { env?: string }) => {
      const { handleSecretReveal } = await import("./commands/secret.js");
      await handleSecretReveal(key, opts);
    });
  secret
    .command("import")
    .description("Import .env text (preview unless --yes)")
    .option(
      "--env <slug>",
      "Target environment overrides; omit for default values",
    )
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

  return program;
}
