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
import {
  printRetiredNotice,
  printTachoAliasNotice,
} from "./commands/retired.js";

const { version } = pkg;

/**
 * The prefix of a single-use enrollment token, as `create_enrollment_token`
 * mints it. `oxagen agent enroll` dispatches on it: `--token` is overloaded
 * across the two scopes the command now serves, so the prefix — not the mere
 * presence of a token — is what says which credential the operator holds
 * (ADR-112 decision 3).
 */
const ENROLLMENT_TOKEN_PREFIX = "oxe_1time_";

/**
 * Refuse flags that belong to the other scope of a merged command, and say so.
 *
 * `agent enroll`, `agent status` and `agent unenroll` each serve two scopes,
 * and each scope carries flags the other does not understand. Dropping one
 * silently is the failure that matters here: an operator who passes `--purge`
 * and reads a success line has been told a local spool was deleted when
 * nothing went near it. Returns true when the caller should stop.
 */
function refusesMisplacedFlags(
  command: string,
  scope: string,
  flags: readonly (readonly [flag: string, given: boolean])[],
): boolean {
  const offending = flags.filter(([, given]) => given).map(([flag]) => flag);
  if (offending.length === 0) return false;
  process.stderr.write(
    `${offending.join(" and ")} ${offending.length === 1 ? "does" : "do"} not apply to \`${command}\` ${scope}.\n`,
  );
  return true;
}

/**
 * The four wrapping subcommands whose names collide with nothing, attached to
 * whichever group asks for them.
 *
 * ADR-112 phase 1b moved the wrapping commands onto `oxagen agent`, and #4879
 * keeps the hidden `oxagen tacho` group as an alias of them, so both groups
 * carry these four. They must not drift apart: a runbook that says the old
 * spelling and one that says `oxagen agent hosts` have to do the same thing,
 * so there is one definition and both parents get it.
 *
 * The other three — `enroll`, `status`, `unenroll` — are not here because their
 * shape differs by parent. On `agent` each also has to serve the server-scoped
 * operation that already owns the name (ADR-112 decision 3); on `tacho` each
 * keeps the host-only shape every enrolled machine was enrolled with.
 */
function addHostWrapCommands(parent: Command): void {
  parent
    .command("reassign")
    .description(
      "Point this host at another workspace (or org): revoke, then enroll again keeping the device key",
    )
    .option("--workspace <slug>", "Workspace slug to report to")
    .option("--org <slug>", "Organization slug (default: the current one)")
    .option(
      "--token <apiKey>",
      "Platform API token (default: the logged-in session)",
    )
    .option("--api-url <url>", "Oxagen API base URL")
    .option(
      "--harness <list>",
      "Replace the harness list (default: keep the current one)",
    )
    .option("--reason <text>", "Reason recorded with the revoke")
    .option(
      "--default",
      "Also make the new org and workspace the CLI default (config.json)",
    )
    .action(
      async (opts: {
        token?: string;
        org?: string;
        workspace?: string;
        apiUrl?: string;
        harness?: string;
        reason?: string;
        default?: boolean;
      }) => {
        const { handleTachoReassign } = await import("./commands/tacho.js");
        if (!(await handleTachoReassign(opts))) process.exitCode = 1;
      },
    );

  parent
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

  parent
    .command("backfill")
    .description(
      "Record the Claude Code sessions this machine ran before it enrolled, from the transcripts Claude Code kept",
    )
    .option(
      "--since <date>",
      "Only sessions that started on or after this UTC date (YYYY-MM-DD)",
    )
    .option(
      "--until <date>",
      "Only sessions that started before this UTC date (YYYY-MM-DD)",
    )
    .option(
      "--project <name>",
      "Only this folder under ~/.claude/projects (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--exclude-project <name>",
      "Skip this folder under ~/.claude/projects (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--session <id>",
      "Only this session and its subagents (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--dry-run", "Read and count, and record and send nothing")
    .option("--json", "Print the report as one JSON object")
    .action(
      async (opts: {
        since?: string;
        until?: string;
        project?: string[];
        excludeProject?: string[];
        session?: string[];
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const { handleTachoBackfill } = await import("./commands/tacho.js");
        process.exitCode = await handleTachoBackfill(opts);
      },
    );

  parent
    .command("verify")
    .description(
      "Run one headless turn (Claude Code by default) and confirm it was chained",
    )
    .option(
      "--harness <name>",
      "claude-code | codex | cursor | stella (default: claude-code)",
    )
    .option("--json", "Machine-readable result")
    .action(async (opts: { harness?: string; json?: boolean }) => {
      const { handleTachoVerify } = await import("./commands/tacho.js");
      if (!(await handleTachoVerify(opts))) process.exitCode = 1;
    });

  parent
    .command("hosts")
    .description(
      "Every machine enrolled in this workspace, with the enforcement tier each of its apps reaches",
    )
    .option("--status <state>", "active | paused | suspended | revoked")
    .option("--limit <n>", "How many to return", (v: string) => Number(v))
    .option("--json", "Machine-readable output")
    .action(
      async (opts: {
        status?: "active" | "paused" | "suspended" | "revoked";
        limit?: number;
        json?: boolean;
      }) => {
        const { handleTachoHosts } = await import("./commands/tacho.js");
        if (!(await handleTachoHosts(opts))) process.exitCode = 1;
      },
    );
}

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

  // ── machine commands: what the recorder writes into a machine (#4879) ──────
  //
  // A harness runs `oxagen hook` on every tool call, the user service runs
  // `oxagen daemon`, a connected app runs `oxagen mcp-stdio`, Claude Code runs
  // `oxagen credential issue`, and git runs `oxagen github credential`. No
  // person types them, so they are hidden from help. `index.ts` sends each
  // straight to `machine/` before this tree is built; they are registered
  // here too so the tree describes every command the executable answers, and
  // a call that reaches the tree still runs the same code. `daemon` names the
  // context daemon ADR-043 retired; the recorder's collector took the name.
  program
    .command("hook", { hidden: true })
    .description(
      "The command hook a wrapped harness runs: reads the payload on stdin and prints the answer",
    )
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const { runHook } = await import("./machine/hook.js");
      await runHook(process.argv);
    });
  const recorderCommands = [
    [
      "daemon",
      "Run the collector daemon in the foreground (what the service runs)",
    ],
    [
      "mcp-stdio",
      "Serve this machine's Oxagen toolbelt to a connected app over stdio",
    ],
    ["credential", "The gateway's custody of model credentials"],
    [
      "github",
      "Route repository Git requests through the host's credential custody",
    ],
    ["arp", "Capture and prepare local Agent Run Protocol checkpoints"],
  ] as const;
  for (const [name, description] of recorderCommands) {
    program
      .command(name, { hidden: true })
      .description(description)
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(async () => {
        const { runRecorderCommand } = await import("./machine/recorder.js");
        await runRecorderCommand(process.argv);
      });
  }

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

  // ── price: the organization's negotiated rates (set_price_entry /
  //    remove_price_entry). `oxagen cost` is the local projection; this is the
  //    platform's price book. Owner/Admin/Billing only. ─────────────────────

  const priceCmd = program
    .command("price")
    .description(
      "The organization's negotiated rates in the price book — what runs are billed at",
    );
  priceCmd
    .command("list")
    .description(
      "Read current prices and optionally scheduled negotiated rates",
    )
    .option("--at <instant>", "RFC 3339 read instant; omit for now")
    .option(
      "--include-scheduled",
      "Include this organization's future negotiated rates",
    )
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const { priceList } = await import("./commands/price.js");
      await priceList(opts as Parameters<typeof priceList>[0]);
    });
  priceCmd
    .command("set")
    .description(
      "Set a negotiated rate for one model and token class — Owner/Admin/Billing only",
    )
    .requiredOption("--provider <provider>", "Provider, e.g. anthropic")
    .requiredOption("--model <model>", "Model id, e.g. claude-sonnet-5")
    .requiredOption(
      "--token-class <class>",
      "input_uncached | cache_read | cache_write_5m | cache_write_1h | output | reasoning | server_tool_request | embedding_input | rerank | image | video_second",
    )
    .requiredOption(
      "--usd-per-million <usd>",
      "Contracted price in USD per 1,000,000 units (2.40, not 2400000)",
    )
    // No `--region`: nothing on the pricing path resolves by region, so a
    // regional rate would apply everywhere and `set_price_entry` refuses one.
    // `price remove` keeps the flag, because it addresses a row that exists.
    .option(
      "--additional-rate <class=usd>",
      "Add a token class to the atomic card",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--alias <model>",
      "Extra model id the rate also prices; repeatable",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--effective-from <instant>",
      "RFC 3339 instant the rate starts applying; omit for now",
    )
    .option("--json", "Output JSON")
    .action(async (opts: Record<string, unknown>) => {
      const { priceSet } = await import("./commands/price.js");
      await priceSet(opts as Parameters<typeof priceSet>[0]);
    });
  priceCmd
    .command("remove")
    .description(
      "End a negotiated rate so the model returns to the list price — Owner/Admin/Billing only",
    )
    .requiredOption("--provider <provider>", "Provider, e.g. anthropic")
    .requiredOption("--model <model>", "Model id, e.g. claude-sonnet-5")
    .requiredOption("--token-class <class>", "The token class to end")
    .option("--region <region>", "Region the rate applies to; omit for any")
    .option(
      "--at <instant>",
      "RFC 3339 instant the rate stops applying; omit for now",
    )
    .option(
      "--confirm-unpriced",
      "Confirm ending this rate even if no list or override price covers the class, which would otherwise refuse and leave it UNPRICED",
    )
    .option("--json", "Output JSON")
    .option(
      "--scheduled-entry-id <id>",
      "Cancel only this scheduled rate and retain the preceding and later rates",
    )
    .action(async (opts: Record<string, unknown>) => {
      const { priceRemove } = await import("./commands/price.js");
      await priceRemove(opts as Parameters<typeof priceRemove>[0]);
    });

  // ── billing: the organization's statement (get_billing_statement /
  //    export_billing_statement, ADR-165). Owner/Admin/Billing only. ────────

  const billingCmd = program
    .command("billing")
    .description("The organization's billing statements");
  billingCmd
    .command("statement")
    .description(
      "Read or export the billing statement for a week, month, quarter, year or custom period",
    )
    .requiredOption(
      "--period <period>",
      "week | month | quarter | year | custom",
    )
    .option(
      "--anchor <date>",
      "A UTC date inside the week, month, quarter or year (YYYY-MM-DD); omit for today",
    )
    .option("--from <instant>", "custom: the first instant, RFC 3339")
    .option(
      "--to <instant>",
      "custom: the first instant after the period, RFC 3339; more than 48 hours after --from",
    )
    .option(
      "--format <format>",
      "summary | csv | html (csv pages every billed governed action)",
      "summary",
    )
    .option("--out <file>", "Write csv or html to this file instead of stdout")
    .option("--top <n>", "summary: rows per breakdown, 1 to 100")
    .option("--page-size <n>", "csv: ledger rows per request, 1 to 50000")
    .option("--json", "Output JSON")
    .action(async (opts: Record<string, unknown>) => {
      const { billingStatement } = await import(
        "./commands/billing-statement.js"
      );
      await billingStatement(opts as Parameters<typeof billingStatement>[0]);
    });

  // ── findings: the workspace's costed findings (list_findings, ADR-062) ─────

  const findingsCmd = program
    .command("findings")
    .description("The workspace's costed findings and what each would save");
  findingsCmd
    .command("list")
    .description(
      "List the findings by the money at stake, 50 a page; with --run, only those citing the run, with the frames each cites",
    )
    .option("--run <id>", "A run id (arun_… or tse_…)")
    .option("--status <status>", "open (default) | applied | dismissed")
    .option("--level <level>", "tool | agent | operator | workspace")
    .option(
      "--subject <key>",
      "An agent key, an operator id (prn_…), a tool name or the workspace id",
    )
    .option("--kind <kind>", "A finding kind, such as retry_loops")
    .option("--cursor <cursor>", "The cursor the previous page printed")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        run?: string;
        status?: string;
        level?: string;
        subject?: string;
        kind?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const { findingsList } = await import("./commands/findings.js");
        await findingsList(opts);
      },
    );

  // ── context: a steering proposal on a lineage (propose_record) ──────────────

  const contextCmd = program
    .command("context")
    .description(
      "Steering: record a proposal on a lineage, or revert a merged one",
    );
  contextCmd
    .command("propose")
    .description(
      "Record a proposal (the record it should become, why); its steering PR is opened and merged in Oxagen",
    )
    .requiredOption(
      "--lineage <id>",
      "The lineage id (the file stem under .oxagen/rules/)",
    )
    .requiredOption(
      "--kind <kind>",
      "rule | constraint | procedure | fact | memory | preference",
    )
    .requiredOption("--force <force>", "must | should | may | info")
    .requiredOption("--scope <scope>", "workspace | repository")
    .requiredOption("--statement <text>", "The single-sentence claim")
    .requiredOption("--rationale <text>", "Why the record should be published")
    .option("--effect <effect>", "require | forbid — a constraint only")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        lineage: string;
        kind: string;
        force: string;
        scope: string;
        statement: string;
        rationale: string;
        effect?: string;
        json?: boolean;
      }) => {
        const { contextPropose } = await import("./commands/context.js");
        await contextPropose(opts);
      },
    );
  contextCmd
    .command("revert <proposalId>")
    .description(
      "Open a steering PR that undoes a merged one (revert_steering_pr); it merges after its own review",
    )
    .option("--json", "Output JSON")
    .action(async (proposalId: string, opts: { json?: boolean }) => {
      const { contextRevert } = await import("./commands/context.js");
      await contextRevert(proposalId, opts);
    });

  // ── repo: the workspace's repositories, one steering and any number linked ──

  const repoCmd = program
    .command("repo")
    .description(
      "The workspace's repositories: one steering repository, which holds its steering record, and the linked ones its agents work on",
    );
  repoCmd
    .command("list")
    .description(
      "Every repository the workspace binds, the steering repository first, with each one's approved default ref and binding id",
    )
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { repoList } = await import("./commands/repo.js");
      await repoList(opts);
    });
  repoCmd
    .command("link")
    .description(
      "Open the steering PR that links a GitHub repository the workspace's GitHub App installation reaches. The link follows the merge.",
    )
    .argument("<owner/name>", "The repository, as GitHub names it")
    .option("--json", "Output JSON")
    .action(async (ref: string, opts: { json?: boolean }) => {
      const { repoLink } = await import("./commands/repo.js");
      await repoLink(ref, opts);
    });
  repoCmd
    .command("unlink")
    .description(
      "Unlink a linked repository by its binding id. A repository workspace.toml lists is removed by a steering PR. The steering repository is refused.",
    )
    .argument("<bindingId>", "The rpb_… binding id `oxagen repo list` shows")
    .option("--json", "Output JSON")
    .action(async (bindingId: string, opts: { json?: boolean }) => {
      const { repoUnlink } = await import("./commands/repo.js");
      await repoUnlink(bindingId, opts);
    });
  repoCmd
    .command("tree")
    .description(
      "What a repository holds under .oxagen/ on its production branch, read from GitHub now",
    )
    .argument("<bindingId>", "The rpb_… binding id `oxagen repo list` shows")
    .option("--json", "Output JSON")
    .action(async (bindingId: string, opts: { json?: boolean }) => {
      const { repoTree } = await import("./commands/repo.js");
      await repoTree(bindingId, opts);
    });
  repoCmd
    .command("branch")
    .description(
      "Confirm or change a repository's production branch; the branch must exist on GitHub",
    )
    .argument("<bindingId>", "The rpb_… binding id `oxagen repo list` shows")
    .argument("<branch>", "The branch to make the production branch")
    .option("--json", "Output JSON")
    .action(
      async (bindingId: string, branch: string, opts: { json?: boolean }) => {
        const { repoBranch } = await import("./commands/repo.js");
        await repoBranch(bindingId, branch, opts);
      },
    );
  repoCmd
    .command("init")
    .description(
      "Open the pull request that adds .oxagen/ to a repository; it never writes to the production branch",
    )
    .argument("<bindingId>", "The rpb_… binding id `oxagen repo list` shows")
    .requiredOption(
      "--workspace-toml <file>",
      "The .oxagen/workspace.toml to propose",
    )
    .option("--mode <mode>", "solo | team | regulated", "team")
    .option(
      "--governance-toml <file>",
      "The .oxagen/rules/governance.toml to propose; drafted from --mode when omitted",
    )
    .option("--json", "Output JSON")
    .action(
      async (
        bindingId: string,
        opts: {
          json?: boolean;
          mode?: string;
          workspaceToml?: string;
          governanceToml?: string;
        },
      ) => {
        const { repoInit } = await import("./commands/repo.js");
        await repoInit(bindingId, opts);
      },
    );
  repoCmd
    .command("governance")
    .description(
      "Set the steering governance mode: who may merge a steering PR in this workspace",
    )
    .requiredOption("--mode <mode>", "solo | team | regulated")
    .option(
      "--workspace <id>",
      "The wrk_… workspace to change; the scoped workspace when omitted",
    )
    .option(
      "--apply-now",
      "Commit to the production branch although the mode in force asks for a reviewed pull request; recorded as steering.governance_overridden",
    )
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        json?: boolean;
        mode?: string;
        workspace?: string;
        applyNow?: boolean;
      }) => {
        const { repoGovernance } = await import("./commands/repo.js");
        await repoGovernance(opts);
      },
    );
  // ── steering: is this checkout running on the records in force? ─────────────

  const steeringCmd = program
    .command("steering")
    .description(
      "Steering records: whether .oxagen/ carries the ones merged on the production branch, Markdown import, and instruction file findings",
    );
  steeringCmd
    .command("status")
    .description(
      "Compare .oxagen/ against the remote production branch and show the two gates",
    )
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { steeringStatus } = await import("./commands/steering.js");
      await steeringStatus(opts);
    });
  steeringCmd
    .command("sync")
    .description(
      "Take .oxagen/ from the remote production branch; refuses while it holds uncommitted or unmerged work",
    )
    .option("--force", "Overwrite local .oxagen/ changes")
    .option(
      "--commit",
      "Commit the synced files instead of leaving them staged",
    )
    .option("--dry-run", "Show what would be taken, and write nothing")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        force?: boolean;
        commit?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const { steeringSync } = await import("./commands/steering.js");
        await steeringSync(opts);
      },
    );
  steeringCmd
    .command("gate")
    .description(
      "The pre-prompt check an agent harness calls. Exit 0 allows, exit 2 refuses with the reason on stderr",
    )
    // Spelled out rather than imported so building the program stays free of
    // module loads: `--help` introspection must not pull in the checker.
    // `steering hooks status` prints the authoritative list at run time.
    .option(
      "--harness <name>",
      "Render for this harness: claude-code, codex, text, json",
      "text",
    )
    .option("--no-network", "Never contact the remote or the Oxagen API")
    .action(async (opts: { harness?: string; network?: boolean }) => {
      const { steeringGate } = await import("./commands/steering.js");
      await steeringGate(opts);
    });
  steeringCmd
    .command("hooks")
    .argument("<action>", "install | remove | status")
    .description("Install the pre-prompt gate into an agent harness")
    .option(
      "--harness <names>",
      "claude-code, codex, a comma-separated list, or all",
      "all",
    )
    .option("--json", "Output JSON")
    .action(
      async (action: string, opts: { harness?: string; json?: boolean }) => {
        const { steeringHooks } = await import("./commands/steering.js");
        await steeringHooks(action, opts);
      },
    );
  steeringCmd
    .command("import")
    .argument(
      "<paths...>",
      "Markdown files, or folders to search for .md, .markdown, and .mdx files",
    )
    .description(
      "Read Markdown files into steering records, Cedar policies, or memories. Previews unless --yes.",
    )
    .option(
      "--as <target>",
      "records, policies, or memories for every file. Without it, each file takes the target its text implies, such as policies for a file with a cedar block.",
    )
    .option(
      "-y, --yes",
      "Open one steering PR with every record and policy marked add, and store every memory marked add as a waiting memory. Records that conflict with a published record are left out.",
    )
    .option("--json", "Output JSON")
    .action(
      async (
        paths: string[],
        opts: { as?: string; yes?: boolean; json?: boolean },
      ) => {
        const { handleSteeringImport } = await import(
          "./commands/steering-import.js"
        );
        await handleSteeringImport(paths, opts);
      },
    );
  steeringCmd
    .command("findings")
    .description(
      "List the statements in linked repositories' instruction files that repeat or contradict a steering record",
    )
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { steeringFindings } = await import(
        "./commands/steering-findings.js"
      );
      await steeringFindings(opts);
    });
  steeringCmd
    .command("promote")
    .argument("<finding-id>", "The crf_… id `oxagen steering findings` shows")
    .description(
      "Propose a new version of the record a statement contradicts, with the statement as its text, and open its steering PR",
    )
    .option("--json", "Output JSON")
    .action(async (findingId: string, opts: { json?: boolean }) => {
      const { steeringPromote } = await import(
        "./commands/steering-promote.js"
      );
      await steeringPromote(findingId, opts);
    });
  steeringCmd
    .command("restore-block")
    .argument("<proposal-id>", "The prp_… proposal whose steering PR holds the file")
    .argument("<path>", "AGENTS.md, CLAUDE.md, or README.md")
    .description(
      "Restore Oxagen's managed block in one file of an open steering PR, as one commit from the production branch",
    )
    .option("--json", "Output JSON")
    .action(
      async (proposalId: string, path: string, opts: { json?: boolean }) => {
        const { steeringRestoreBlock } = await import(
          "./commands/steering-restore-block.js"
        );
        await steeringRestoreBlock(proposalId, path, opts);
      },
    );

  // ── tools: the workspace's MCP servers (migrate_tools_to_steering) ─────────

  const toolsCmd = program
    .command("tools")
    .description("The workspace's connected MCP servers and their tools");
  toolsCmd
    .command("migrate")
    .description(
      "Open the pull request that moves the workspace's MCP servers into its steering repo, or print the one already open",
    )
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { toolsMigrate } = await import("./commands/tools.js");
      await toolsMigrate(opts);
    });

  // ── run: the recorded run (export_run, get_run_export) ────────────────────

  // `oxagen run -- <agent>` is the contained launcher (ADR-096, ADR-152);
  // `oxagen run export <id>` and its siblings stay subcommands. Commander
  // dispatches a subcommand name first, and everything after `--` is the
  // agent's own command line.
  const runCmd = program
    .command("run")
    .description(
      "Start an agent under the contained launcher (`oxagen run -- claude -p <task>`), or read a recorded run: its chain and seal, and its signed evidence bundle",
    )
    .option("--image <ref>", "The contained image (or OXAGEN_CONTAINED_IMAGE)")
    .option(
      "--workspace <dir>",
      "The repository root to mount at /workspace (default: the current directory)",
    )
    .option(
      "--github-repository <owner/name>",
      "The one repository the run may fetch and push, through Oxagen's Git custody. The workspace must have it bound.",
    )
    .argument("[command...]", "After --: claude or codex, then its arguments")
    .action(
      async (
        command: string[],
        opts: { image?: string; workspace?: string; githubRepository?: string },
      ) => {
        if (command.length === 0) {
          runCmd.help();
          return;
        }
        const { handleContainedRun } = await import("./commands/tacho.js");
        process.exitCode = await handleContainedRun(command, opts);
      },
    );
  runCmd
    .command("list")
    .description("List the workspace's runs, newest first")
    .option("--limit <n>", "Page size, 1 to 100", (v) => Number.parseInt(v, 10))
    .option("--cursor <cursor>", "The cursor the previous page printed")
    .option("--json", "Output the raw contract payload as JSON")
    .action(async (opts: { limit?: number; cursor?: string; json?: boolean }) =>
      (await import("./commands/run.js")).runList(opts),
    );
  runCmd
    .command("show")
    .description(
      "Show one run: its header, the pause in force, a page of its frames, and its subagent chains",
    )
    .argument("<run-id>", "The run's public id (arun_… or tse_…)")
    .option("--after <cursor>", "The cursor the previous page printed")
    .option(
      "--session <uuid>",
      "A subagent chain's session id, from the chains the run lists",
    )
    .option("--json", "Output the raw contract payload as JSON")
    .action(
      async (
        runId: string,
        opts: { after?: string; session?: string; json?: boolean },
      ) => {
        const { runShow } = await import("./commands/run.js");
        await runShow(runId, opts);
      },
    );
  runCmd
    .command("chain")
    .description(
      "Show what makes a run's record tamper-evident: the hash rule, the root, the checkpoints, the gaps, and the replay ladder",
    )
    .argument("<run-id>", "The run's public id (arun_… or tse_…)")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { runChain } = await import("./commands/run.js");
      await runChain(runId, opts);
    });
  runCmd
    .command("turns")
    .description(
      "Show a run's cost turn by turn: each turn's model and tool steps, frames, cache hit, cost, and the cost so far",
    )
    .argument("<run-id>", "The run's public id (arun_… or tse_…)")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { runTurns } = await import("./commands/run.js");
      await runTurns(runId, opts);
    });
  runCmd
    .command("transcript")
    .description(
      "Read one page of a run's transcript: its entries, the count per chip over the whole run, and a search of the kept bodies",
    )
    .argument("<run-id>", "The run's public id (arun_… or tse_…)")
    .option("--zoom <zoom>", "turns, steps, or everything", "steps")
    .option(
      "--kinds <kinds>",
      "The chips to keep, comma-separated (thinking,seal)",
    )
    .option("--query <words>", "Words to search the entries for, ignoring case")
    .option("--after <cursor>", "The cursor the previous page printed")
    .option("--limit <n>", "Page size, 1 to 500", (v) => Number.parseInt(v, 10))
    .option("--text <text>", "How much of each body to carry: excerpt or full")
    .option("--json", "Output the raw contract payload as JSON")
    .action(
      async (
        runId: string,
        opts: {
          zoom?: string;
          kinds?: string;
          query?: string;
          after?: string;
          limit?: number;
          text?: string;
          json?: boolean;
        },
      ) => {
        const { runTranscript } = await import("./commands/run.js");
        await runTranscript(runId, opts);
      },
    );
  runCmd
    .command("context")
    .description(
      "Show what each of a run's model requests carried: the prompt tokens and each block's share of them",
    )
    .argument("<run-id>", "The run's public id (arun_… or tse_…)")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { runContext } = await import("./commands/run-context.js");
      await runContext(runId, opts);
    });
  runCmd
    .command("export")
    .description(
      "Queue the signed, offline-verifiable evidence bundle for a sealed run — Owner/Admin only",
    )
    .argument("<run-id>", "The run's public id (arun_… or tse_…)")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { runExport } = await import("./commands/run.js");
      await runExport(runId, opts);
    });
  runCmd
    .command("export-status")
    .description(
      "Show where a run export stands and, once it is ready, its download link",
    )
    .argument(
      "<export-id>",
      "The export id `oxagen run export` printed (rexp_…)",
    )
    .option("--json", "Output JSON")
    .action(async (exportId: string, opts: { json?: boolean }) => {
      const { runExportStatus } = await import("./commands/run.js");
      await runExportStatus(exportId, opts);
    });
  runCmd
    .command("download")
    .description(
      "Download a ready run export and check its sha256 against the recorded digest",
    )
    .argument(
      "<export-id>",
      "The export id `oxagen run export` printed (rexp_…)",
    )
    .option(
      "--out <file>",
      "Where to write the zip (default: <run-id>-<export-id>.zip here)",
    )
    .option("--json", "Output JSON")
    .action(
      async (exportId: string, opts: { json?: boolean; out?: string }) => {
        const { runDownload } = await import("./commands/run.js");
        await runDownload(exportId, opts);
      },
    );
  runCmd
    .command("pause-all")
    .description(
      "Pause every live wrapped run in the workspace as one recorded decision. Org Owner or Admin, or workspace Owner",
    )
    .requiredOption("--reason <text>", "Why the runs are paused (recorded)")
    .option("--json", "Output JSON")
    .action(async (opts: { reason: string; json?: boolean }) => {
      const { runPauseAll } = await import("./commands/run.js");
      await runPauseAll(opts);
    });
  runCmd
    .command("answer")
    .description(
      "Answer the question a run paused to ask: --text for an agent's own question, --link or --create for a repository the workspace has not bound",
    )
    .argument("<interjection-id>", "The question's id (inj_…)")
    .option("--text <answer>", "A free-text answer to an agent's own question")
    .option(
      "--link",
      "Open the steering PR that links the repository to this workspace. Org Owner or Admin, or workspace Owner",
    )
    .option(
      "--create <name>",
      "Create a workspace for the repository, with skills off. Needs --slug",
    )
    .option("--slug <slug>", "The new workspace's slug, with --create")
    .option("--json", "Output JSON")
    .action(
      async (
        interjectionId: string,
        opts: {
          text?: string;
          link?: boolean;
          create?: string;
          slug?: string;
          json?: boolean;
        },
      ) => {
        const { runAnswer } = await import("./commands/run.js");
        await runAnswer(interjectionId, opts);
      },
    );

  // ── verify: check a run export offline ──────────────────────────────────────

  program
    .command("verify")
    .description(
      "Check a run export bundle offline: each frame's digest and link, the Merkle root, and each signature",
    )
    .argument("<bundle>", "The bundle's .zip file or its extracted directory")
    .option("--json", "Output the verification as JSON")
    .action(async (bundle: string, opts: { json?: boolean }) => {
      const { verifyBundle } = await import("./commands/verify.js");
      await verifyBundle(bundle, opts);
    });

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

  // ── approvals: the resolved approval ledger ─────────────────────────────────

  const approvalsCmd = program
    .command("approvals")
    .description("Read the workspace's approval ledger");
  approvalsCmd
    .command("resolved")
    .description(
      "List resolved approvals, most recently resolved first, including a call a decision rule auto-approved with no person",
    )
    .option("--run <runId>", "Only approvals recorded on this run")
    .option(
      "--since <instant>",
      "Only rows resolved at or after this instant (ISO-8601)",
    )
    .option(
      "--until <instant>",
      "Only rows resolved at or before this instant (ISO-8601)",
    )
    .option("--limit <n>", "Page size, 1 to 100", (v) => Number.parseInt(v, 10))
    .option("--cursor <cursor>", "The nextCursor of the previous page")
    .option("--json", "Output the raw contract payload as JSON", false)
    .action(
      async (opts: {
        run?: string;
        since?: string;
        until?: string;
        limit?: number;
        cursor?: string;
        json?: boolean;
      }) => {
        const { approvalsResolved } = await import("./commands/approval.js");
        await approvalsResolved(opts);
      },
    );

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

  // ── memory: the workspace's memories, collected from enrolled hosts ─────────

  const memory = program
    .command("memory")
    .description(
      "Review the memories agents wrote in their harnesses: list, show, promote into steering records, or dismiss",
    );
  memory
    .command("list")
    .description(
      "List the workspace's memories ranked by uses, one row per group of memories that say the same thing",
    )
    .option(
      "--state <states>",
      "States to list, comma-separated: waiting, in_pr, promoted, dismissed, retired (default waiting,in_pr)",
    )
    .option(
      "--harness <harness>",
      "Only memories this harness keeps: claude-code, codex, cursor, stella, or claude-desktop",
    )
    .option("--agent <lineage>", "Only memories this agent wrote")
    .option(
      "--repository <repo>",
      "Only memories scoped to this repository, such as github.com/acme/api",
    )
    .option(
      "--type <type>",
      "Only memories of this Claude Code type: user, feedback, project, or reference",
    )
    .option("--limit <n>", "Groups per page (default 50)")
    .option("--offset <n>", "Groups to skip")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        state?: string;
        harness?: string;
        agent?: string;
        repository?: string;
        type?: string;
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
    .description(
      "Show one memory with its full text, its source, the runs that used it, and its memory PR",
    )
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const { handleMemoryShow } = await import("./commands/memory.js");
      await handleMemoryShow(id, opts);
    });
  memory
    .command("promote <ids...>")
    .description(
      "Promote waiting memories into draft steering records on the open memory PR, or open one. One record per id",
    )
    .option("--one-record", "Cite every id in one record")
    .option(
      "--statement <text>",
      "The record's body. Defaults to the first memory's statement",
    )
    .option(
      "--kind <kind>",
      "business-rule, code-rule, constraint, procedure, fact, preference, or memory",
    )
    .option(
      "--force <force>",
      "must, should, may, or info. Defaults to should for a rule kind, may for a preference, and info for a fact or a memory",
    )
    .option("--effect <effect>", "require or forbid. Required for a constraint")
    .option(
      "--repo <repo>",
      "Scope the record to a repository, such as github.com/acme/api. Repeat or comma-separate for more",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--no-same-text",
      "Cite only the ids given, not the waiting memories that say the same thing",
    )
    .option("--json", "Output JSON")
    .action(
      async (
        ids: string[],
        opts: {
          oneRecord?: boolean;
          statement?: string;
          kind?: string;
          force?: string;
          effect?: string;
          repo?: string[];
          sameText?: boolean;
          json?: boolean;
        },
      ) => {
        const { handleMemoryPromote } = await import("./commands/memory.js");
        await handleMemoryPromote(ids, opts);
      },
    );
  memory
    .command("dismiss <ids...>")
    .description(
      "Dismiss memories so the curator does not propose them again, or restore them with --restore",
    )
    .option("--restore", "Bring dismissed memories back to waiting")
    .option("--json", "Output JSON")
    .action(
      async (ids: string[], opts: { restore?: boolean; json?: boolean }) => {
        const { handleMemoryDismiss } = await import("./commands/memory.js");
        await handleMemoryDismiss(ids, opts);
      },
    );
  memory
    .command("drop <number> <path>")
    .description(
      "Drop one proposed record from an open memory PR. When the PR merges, the record's statements are rejected and its memories wait again",
    )
    .option("--json", "Output JSON")
    .action(async (number: string, path: string, opts: { json?: boolean }) => {
      const { handleMemoryDrop } = await import("./commands/memory.js");
      await handleMemoryDrop(number, path, opts);
    });
  memory
    .command("import <files...>")
    .description(
      "Read Markdown files into steering records with a kind and a force for each statement. Previews unless --yes.",
    )
    .option(
      "-y, --yes",
      "Open one steering PR with every record marked add. Records that conflict with a published record are left out.",
    )
    .option("--json", "Output JSON")
    .action(
      async (files: string[], opts: { yes?: boolean; json?: boolean }) => {
        const { handleMemoryImport } = await import("./commands/memory.js");
        await handleMemoryImport(files, opts);
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
    .option(
      "--org <slug>",
      "Link this organization instead of choosing one; works without a terminal",
    )
    .option(
      "--workspace <slug>",
      "Link this workspace instead of choosing one; relinks when the project names another",
    )
    .option("--json", "Output JSON instead of human-readable text")
    .option("--no-link", "Skip the workspace linker step entirely")
    .action(
      async (opts: {
        org?: string;
        workspace?: string;
        json?: boolean;
        link?: boolean;
      }) => {
        const { handleInit } = await import("./commands/init.js");
        await handleInit({
          org: opts.org,
          workspace: opts.workspace,
          json: opts.json,
          noLink: opts.link === false,
        });
      },
    );

  // ── pull: the workspace's published steering, into this directory ─────────

  program
    .command("pull")
    .description(
      "Write the steering published in this workspace into this directory's .oxagen/",
    )
    .option(
      "--binding <rpb_id>",
      "Pull from this repository binding instead of the workspace's main repository",
    )
    .option("--force", "Overwrite files edited here")
    .option("--dry-run", "Show what would change, and write nothing")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        binding?: string;
        force?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const { pull } = await import("./commands/pull.js");
        await pull(opts);
      },
    );

  // ── check: the steering PR checks, on a clone before you push ─────────────

  program
    .command("check")
    .argument(
      "[paths...]",
      "Report only the findings in these files and folders",
    )
    .description(
      "Run the steering PR checks on this clone of a steering repo, before you push",
    )
    .option(
      "--base <ref>",
      "Compare with this ref instead of origin/HEAD, then origin/main",
    )
    .option(
      "--refresh",
      "Fetch the published index again, even when the cached copy is fresh",
    )
    .option("--json", "Print one JSON object per finding")
    .action(
      async (
        paths: string[],
        opts: { base?: string; refresh?: boolean; json?: boolean },
      ) => {
        const { check } = await import("./commands/check.js");
        await check(paths, opts);
      },
    );

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

  // ── tacho: the hidden alias of `oxagen agent`'s machine commands ───────────
  //
  // Hidden, and replaced by `oxagen agent` (ADR-112 phase 1, spec §2.1, #4879:
  // nobody types the old word). It still runs, and the subcommands below are
  // unchanged, because every machine enrolled before the rename was enrolled
  // with this group's `enroll` and that string is in scripts, runbooks, and
  // the managed settings documents MDM has already pushed. Refusing it would
  // turn a rename into an outage.
  //
  // All seven now also live on `oxagen agent` (ADR-112 phase 1b). Three of the
  // names were taken there by server-scoped operations, and they resolve by
  // argument rather than by renaming either side: `agent status` bare reports
  // this machine and `agent status <agent>` reports that agent, the same split
  // applies to `unenroll`, and `agent enroll` dispatches on the token's prefix
  // (`oxe_1time_` is the single-use enrollment token, anything else or no token
  // at all is the logged-in session). This group keeps its own definitions
  // rather than forwarding, so the shape an enrolled machine's runbook already
  // passes stays exactly as it was — a forwarded `tacho enroll` would land on
  // the merged command and be re-parsed, which is a behaviour change dressed up
  // as compatibility.
  //
  // docs/specs/tacho/spec.md section 5.1. The work lives in @oxagen/recorder;
  // these commands lend it the CLI's credentials so enrolling this machine
  // needs no --token after `oxagen login`.

  const tacho = program
    .command("tacho", { hidden: true })
    .description(
      "Deprecated. Wrap this machine's agent sessions: record and gate them through Oxagen",
    );

  // One line on the way past, naming the command that replaced this one. On
  // stderr so it never lands in the output of `--json` subcommands that a
  // script is parsing.
  tacho.hook("preSubcommand", (_group, subcommand) => {
    printTachoAliasNotice(subcommand.name());
  });

  tacho
    .command("enroll")
    .description(
      "Enroll this machine: device key, host API key, collector service, Claude Code hooks",
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
    .option(
      "--port <n>",
      "Loopback port for the collector daemon",
      (v: string) => Number(v),
    )
    .option("--no-service", "Do not install the user service")
    .option("--managed", "Also print the managed settings document for MDM")
    .option(
      "--print-managed",
      "Only print the managed settings document; do not write user settings",
    )
    .option("--force", "Enroll again even if already enrolled")
    .option(
      "--harness <list>",
      "Harnesses to hook: claude-code, codex, cursor, stella, or a comma list such as claude-code,cursor",
    )
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
        harness?: string;
        verify?: boolean;
      }) => {
        const { handleTachoEnroll } = await import("./commands/tacho.js");
        if (!(await handleTachoEnroll(opts))) process.exitCode = 1;
      },
    );

  addHostWrapCommands(tacho);

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
    .option(
      "--harness <name>",
      "The agent to unenroll, by the harness it hooks, when this machine holds more than one enrollment",
    )
    .option("--all", "Unenroll every agent on this machine")
    .action(
      async (opts: {
        token?: string;
        purge?: boolean;
        reason?: string;
        harness?: string;
        all?: boolean;
      }) => {
        const { handleTachoUnenroll } = await import("./commands/tacho.js");
        if (!(await handleTachoUnenroll(opts))) process.exitCode = 1;
      },
    );

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
    .option(
      "--org <slug>",
      "Organization slug; with a saved session and no --token, rescopes the default without a browser",
    )
    .option(
      "--workspace <slug>",
      "Workspace slug; with a saved session and no --token, rescopes the default without a browser",
    )
    .option(
      "--browser",
      "Open the browser even without a TTY, and even when a session is saved (what the desktop app runs)",
    )
    .option("--no-browser", "Prompt for token instead of opening the browser")
    .option(
      "--signup",
      "Create an Oxagen account first: opens the sign-up page, then the same consent page (implies --browser)",
    )
    .action(
      async (opts: {
        token?: string;
        org?: string;
        workspace?: string;
        browser?: boolean;
        signup?: boolean;
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
  // agent key, resolved against the workspace's registered agents. Environments
  // are governed configuration records: binding one does not run anything.

  const agent = program
    .command("agent")
    .description("Govern the workspace's registered agents");

  // ── agent identity: register_agent / get_agent / revoke_tacho_enrollment (MC spec §14.1) ──

  agent
    .command("register")
    .description(
      "Register an agent: one harness on one runtime, carrying a toolbelt. Prints its credential once. Owner or Admin only",
    )
    .requiredOption("--name <name>", "Display name")
    .requiredOption(
      "--harness <harness>",
      "stella | claude-code | codex | cursor | claude-agent-sdk | custom",
    )
    .requiredOption("--runtime <rtm_id>", "The runtime it runs on (rtm_…)")
    .option(
      "--slug <slug>",
      "Lowercase words joined by hyphens; derived from --name when omitted",
    )
    .option(
      "--toolbelt <tbt_id>",
      "The toolbelt it carries (tbt_…); the All tools belt when omitted",
    )
    .option("--description <text>", "What the agent is for")
    .option("--validity-days <n>", "Credential lifetime in days (1 to 365)")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        slug?: string;
        name?: string;
        harness?: string;
        runtime?: string;
        toolbelt?: string;
        description?: string;
        validityDays?: string;
        json?: boolean;
      }) => {
        const { agentRegister } = await import("./commands/agent.js");
        await agentRegister(opts);
      },
    );
  agent
    .command("status")
    .argument(
      "[agent]",
      "An agent id or slug. Omit it to report this machine instead",
    )
    .description(
      "With an agent: its identity, runtime, toolbelt, versions, credentials, roles and hosts. Without one: this machine's enrollment, daemon, hooks, bundle and spool",
    )
    .option("--json", "Output JSON")
    .action(
      async (agentHandle: string | undefined, opts: { json?: boolean }) => {
        if (agentHandle === undefined) {
          const { handleTachoStatus } = await import("./commands/tacho.js");
          if (!(await handleTachoStatus(opts))) process.exitCode = 1;
          return;
        }
        const { agentStatus } = await import("./commands/agent.js");
        await agentStatus(agentHandle, opts);
      },
    );
  agent
    .command("unenroll")
    .argument(
      "[agent]",
      "An agent id or slug. Omit it to unenroll this machine instead",
    )
    .description(
      "With an agent: revoke its live host enrollments, or one host with --host — Owner/Admin only. Without one: remove this machine's hooks and service, revoke its enrollment, delete its host key",
    )
    .option("--host <tch_id>", "With an agent: only this host")
    .option("--reason <text>", "Recorded on the host and in the revoke command")
    .option("--json", "With an agent: output JSON")
    .option(
      "--token <apiKey>",
      "Without an agent: operator token for the server-side revoke",
    )
    .option(
      "--purge",
      "Without an agent: also delete the local WAL, spool, and quarantine",
    )
    .option(
      "--harness <name>",
      "Without an agent: the one to unenroll, by the harness it hooks, when this machine holds more than one enrollment",
    )
    .option("--all", "Without an agent: unenroll every agent on this machine")
    .action(
      async (
        agentHandle: string | undefined,
        opts: {
          host?: string;
          reason?: string;
          json?: boolean;
          token?: string;
          purge?: boolean;
          harness?: string;
          all?: boolean;
        },
      ) => {
        if (agentHandle === undefined) {
          if (
            refusesMisplacedFlags(
              "oxagen agent unenroll",
              "without an agent argument",
              [
                ["--host", opts.host !== undefined],
                ["--json", opts.json === true],
              ],
            )
          ) {
            process.exitCode = 1;
            return;
          }
          const { handleTachoUnenroll } = await import("./commands/tacho.js");
          if (!(await handleTachoUnenroll(opts))) process.exitCode = 1;
          return;
        }
        if (
          refusesMisplacedFlags(
            "oxagen agent unenroll",
            "with an agent argument",
            [
              ["--token", opts.token !== undefined],
              ["--purge", opts.purge === true],
              ["--harness", opts.harness !== undefined],
              ["--all", opts.all === true],
            ],
          )
        ) {
          process.exitCode = 1;
          return;
        }
        const { agentUnenroll } = await import("./commands/agent.js");
        await agentUnenroll(agentHandle, opts);
      },
    );
  agent
    .command("uninstall")
    .description(
      "Take Oxagen off this machine without the desktop app: unenroll every agent, then remove the app's per-user copy, PATH links, and shell profile lines, and ~/.config/oxagen, which holds your `oxagen login` session",
    )
    .option("--token <apiKey>", "Operator token for the server-side revoke")
    .option("--reason <text>", "Reason recorded with each revoke")
    .action(async (opts: { token?: string; reason?: string }) => {
      const { handleTachoUninstall } = await import("./commands/tacho.js");
      if (!(await handleTachoUninstall(opts))) process.exitCode = 1;
    });

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

  // ── agent enroll: wrap this machine (#2967, ADR-112 phase 1b, #4879) ───────
  //
  // One command over two scopes, because §2.1 names one. With a single-use
  // enrollment token (the scripted path of the register flow, MC spec §14.1)
  // this machine becomes that registered agent's host and no `oxagen login` is
  // needed. With a platform API token, or with nothing, it wraps this machine
  // under the logged-in session. Both end in the same `@oxagen/recorder/cli`
  // routine; they differ in the credential presented. Either one also moves
  // every agent the machine enrolled under the old names to `oxagen hook` and
  // `oxagen daemon`.
  //
  // The dispatch is on the token's prefix rather than on whether a token was
  // given, because `--token` means something different on each side and an
  // operator holds one credential, not a preference between two commands.
  agent
    .command("enroll")
    .description(
      "Wrap this machine: device key, host credential, collector service, harness hooks. A single-use enrollment token (oxe_1time_…) enrolls it as that registered agent's host; anything else uses a platform API token or the logged-in session",
    )
    .option(
      "--token <token>",
      "A single-use enrollment token (oxe_1time_…) shown once at registration, or a platform API token (default: the logged-in session)",
    )
    .option("--org <slug>", "Organization slug (default: the logged-in org)")
    .option(
      "--workspace <slug>",
      "Workspace slug (default: the logged-in workspace)",
    )
    .option("--api-url <url>", "Oxagen API base URL")
    .option(
      "--port <n>",
      "Loopback port for the collector daemon",
      (v: string) => Number(v),
    )
    .option("--no-service", "Do not install the user service")
    .option("--managed", "Also print the managed settings document for MDM")
    .option(
      "--print-managed",
      "Only print the managed settings document; do not write user settings",
    )
    .option("--force", "Enroll again even if already enrolled")
    .option(
      "--harness <list>",
      "Harnesses to hook: claude-code, codex, cursor, stella, or a comma list such as claude-code,cursor",
    )
    .option(
      "--credentials <mode>",
      "brokered (default): the gateway holds each model vendor key and the harness holds a run token; passthrough: the harness keeps its own key",
    )
    .option(
      "--validity-days <n>",
      "How many days the enrollment stays valid (default: 180)",
      (v: string) => Number(v),
    )
    .option("--verify", "Run a headless Claude Code turn afterwards")
    .action(
      async (opts: {
        token?: string;
        org?: string;
        workspace?: string;
        apiUrl?: string;
        port?: number;
        service?: boolean;
        managed?: boolean;
        printManaged?: boolean;
        force?: boolean;
        harness?: string;
        credentials?: string;
        validityDays?: number;
        verify?: boolean;
      }) => {
        const token = opts.token;
        if (token !== undefined && token.startsWith(ENROLLMENT_TOKEN_PREFIX)) {
          if (
            refusesMisplacedFlags(
              "oxagen agent enroll",
              "with an enrollment token",
              [
                ["--org", opts.org !== undefined],
                ["--workspace", opts.workspace !== undefined],
                ["--managed", opts.managed === true],
                ["--print-managed", opts.printManaged === true],
                ["--verify", opts.verify === true],
              ],
            )
          ) {
            process.exitCode = 1;
            return;
          }
          const { handleAgentEnroll } = await import(
            "./commands/agent-enroll.js"
          );
          const enrolled = await handleAgentEnroll({
            token,
            harness: opts.harness,
            port: opts.port,
            service: opts.service,
            force: opts.force,
            apiUrl: opts.apiUrl,
            credentials: opts.credentials,
            validityDays: opts.validityDays,
          });
          if (!enrolled) process.exitCode = 1;
          return;
        }
        const { handleTachoEnroll } = await import("./commands/tacho.js");
        if (!(await handleTachoEnroll(opts))) process.exitCode = 1;
      },
    );

  addHostWrapCommands(agent);

  // ── agent run and detect: the rest of the recorder's commands (#4879) ──────
  agent
    .command("run")
    .description(
      "Run one agent session under Oxagen control: a custom agent by its own command (`oxagen agent run --name my-agent -- ./my-agent`), a wrapped harness through its hooks, or Claude Code or Codex in the contained launcher with --contained",
    )
    .option(
      "--name <agent>",
      "The custom agent's name: lowercase letters, digits, '.', '_', '-' (default: from the command)",
    )
    .option(
      "--contained",
      "Start Claude Code or Codex in the contained launcher (Linux and Docker)",
    )
    .option(
      "--image <ref>",
      "With --contained: the image (or OXAGEN_CONTAINED_IMAGE)",
    )
    .option(
      "--workspace <dir>",
      "With --contained: the repository root to mount at /workspace (default: the current directory)",
    )
    .option(
      "--github-repository <owner/name>",
      "With --contained: the one repository the run may fetch and push, through Oxagen's Git custody. The workspace must have it bound.",
    )
    .argument("[command...]", "After --: the agent's command and its arguments")
    .action(
      async (
        command: string[],
        opts: {
          name?: string;
          contained?: boolean;
          image?: string;
          workspace?: string;
          githubRepository?: string;
        },
      ) => {
        // An empty command reaches the recorder too, which names the form.
        const { handleAgentRun } = await import("./commands/tacho.js");
        process.exitCode = await handleAgentRun(command, opts);
      },
    );

  agent
    .command("detect")
    .description(
      "Which harnesses this machine has (claude, codex, cursor-agent, stella) and which are enrolled",
    )
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const { handleAgentDetect } = await import("./commands/tacho.js");
      if (!(await handleAgentDetect(opts))) process.exitCode = 1;
    });

  // ── work: work orders sent to this machine's agents (ADR-251) ──────────────
  //
  // A person sends an approved brief to an agent in the app. The agent's
  // host keeps the work order until the person at the machine starts it
  // here. `start` claims the order first, so nothing runs for an order the
  // server refuses. Inside the run, the agent records each criterion it met
  // with `claim`.

  const work = program
    .command("work")
    .description(
      "See and start the work orders Oxagen sent to the agents on this machine, and claim a criterion from inside a run",
    );
  work
    .command("list")
    .description("List the work orders waiting on this machine")
    .action(async () => {
      const { handleWorkList } = await import("./commands/tacho.js");
      process.exitCode = await handleWorkList();
    });
  work
    .command("start")
    .description(
      "Claim a work order, then start the agent in this directory with the order's brief as its first prompt",
    )
    .argument("<work-order>", "The work order's id, which starts with wo_")
    .action(async (workOrderId: string) => {
      const { handleWorkStart } = await import("./commands/tacho.js");
      process.exitCode = await handleWorkStart(workOrderId);
    });
  work
    .command("claim")
    .description(
      "From inside a work order's run, claim that the pushed head commit meets one criterion of the brief. A person still decides.",
    )
    .argument("<criterion>", "The criterion's id from the brief, such as c1")
    .requiredOption("--text <text>", "How the commit meets the criterion")
    .action(async (criterionId: string, opts: { text: string }) => {
      const { handleWorkClaim } = await import("./commands/tacho.js");
      process.exitCode = await handleWorkClaim(criterionId, opts);
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
