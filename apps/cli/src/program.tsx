/**
 * program.ts — The Commander command tree for the `oxagen` CLI.
 *
 * Extracted from index.tsx so the exact same command set that drives
 * `oxagen --help` is the single source of truth for the REPL's slash-command
 * menu (see slash/catalog.ts → describeCliCommands). Building the program has no
 * side effects — every handler is a dynamic `import()` inside its action — so the
 * REPL can construct it purely to introspect command names + descriptions
 * without running anything.
 */
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { parseModeArg, type PermissionMode } from "./agent/permissions.js";

const { version } = pkg;

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

/** Metadata for one CLI command, surfaced in the REPL slash-command menu. */
export interface CliCommandMeta {
  /** Command name as typed (e.g. "graph", "cost"). */
  name: string;
  /** One-line description (the same string `--help` prints). */
  description: string;
  /** Argument hint derived from the command's declared arguments, e.g. "<query> [focus]". */
  argumentHint?: string;
}

/**
 * Read every top-level command's name + description + argument shape straight
 * from the Commander tree. This is what makes the slash menu and `--help` stay
 * in lockstep: there is no second list to drift.
 */
export function describeCliCommands(program: Command): CliCommandMeta[] {
  return program.commands.map((cmd) => {
    const hint = cmd.registeredArguments
      .map((arg) => (arg.required ? `<${arg.name()}>` : `[${arg.name()}]`))
      .join(" ");
    return {
      name: cmd.name(),
      description: cmd.description(),
      argumentHint: hint || undefined,
    };
  });
}

/**
 * Construct the full `oxagen` command tree. Pure: no parsing, no I/O, no
 * side effects — `index.tsx` parses it, the REPL only introspects it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("oxagen")
    .description("Agentic coding assistant — powered by the Oxagen context engine")
    .version(version)
    .argument("[prompt...]", "One-shot prompt (runs and exits)")
    .option("-m, --model <slug>", "Gateway model slug (overrides config/default)")
    .option(
      "--effort <level>",
      "Reasoning effort for models that support it: low | medium | high | xhigh | max (omit = model default / adaptive)",
    )
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
      "--local",
      "Run locally with your own key (BYOK) — AI_GATEWAY_API_KEY (any vendor, preferred) or ANTHROPIC_API_KEY (Anthropic models only), no Oxagen account",
      false,
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
    .option(
      "--output-format <format>",
      "One-shot output format: text | json (single result envelope) | stream-json (JSONL events)",
    )
    .option(
      "--max-steps <n>",
      "Cap the agent tool loop at n steps per execution round (default 256)",
    )
    .action(
      async (
        promptWords: string[],
        opts: {
          model?: string;
          effort?: string;
          readonly?: boolean;
          mode?: string;
          local?: boolean;
          pipeline?: boolean;
          verbose?: boolean;
          agent?: string;
          outputFormat?: string;
          maxSteps?: string;
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
        let outputFormat: "text" | "json" | "stream-json" | undefined;
        if (opts.outputFormat) {
          if (!["text", "json", "stream-json"].includes(opts.outputFormat)) {
            process.stderr.write(
              `Error: invalid --output-format "${opts.outputFormat}". Use text, json, or stream-json.\n`,
            );
            process.exitCode = 1;
            return;
          }
          outputFormat = opts.outputFormat as "text" | "json" | "stream-json";
        }
        let maxSteps: number | undefined;
        if (opts.maxSteps !== undefined) {
          maxSteps = Number.parseInt(opts.maxSteps, 10);
          if (!Number.isFinite(maxSteps) || maxSteps < 1) {
            process.stderr.write(
              `Error: invalid --max-steps "${opts.maxSteps}". Use a positive integer.\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        // --local forces BYOK: run against the shell's AI_GATEWAY_API_KEY (or
        // ANTHROPIC_API_KEY fallback), not the platform account (requireSession
        // reads OXAGEN_LOCAL).
        if (opts.local) process.env["OXAGEN_LOCAL"] = "1";
        // ADR-019 §4: require an Oxagen account before any agent-path command —
        // UNLESS BYOK applies: `--local`/OXAGEN_LOCAL, or (when not logged in) an
        // AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY is present, in which case the
        // CLI runs locally instead of exiting. Non-agent utility commands (config,
        // settings, login, logout, etc.) bypass this gate automatically.
        const { requireSession } = await import("./lib/session.js");
        const session = requireSession();

        const runOpts = {
          session,
          model: opts.model,
          effort: opts.effort,
          readOnly: opts.readonly,
          mode,
          bare: opts.pipeline === false,
          verbose: opts.verbose,
          outputFormat,
          maxSteps,
        };

        // Feed the anonymous usage-telemetry accumulator (index.tsx emits the
        // event after this action resolves): pipeline_used and byok are known
        // right here from data already destructured above, so record them
        // directly rather than re-deriving them generically at the exit hook.
        {
          const { markPipelineUsed, setByok } = await import("./telemetry/usage.js");
          markPipelineUsed(!runOpts.bare);
          setByok(session.orgSlug === "local");
        }

        // --agent: run the prompt as a named agent (its prompt, tools, model).
        if (opts.agent) {
          if (!prompt) {
            process.stderr.write("Error: --agent requires a prompt, e.g. `oxagen --agent reviewer \"…\"`.\n");
            process.exitCode = 1;
            return;
          }
          if (outputFormat && outputFormat !== "text") {
            process.stderr.write(
              "Error: --output-format json/stream-json is not supported with --agent (text only).\n",
            );
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

  // ── view: agent dashboard ───────────────────────────────────────────────────

  program
    .command("view")
    .description("Launch the agent dashboard (memory, compile, sessions)")
    .action(async () => {
      const { launchAgentView } = await import("./tui/agent-view/index.js");
      launchAgentView();
    });

  // ── agents: the agents screen (fleet) ───────────────────────────────────────

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
      "--no-isolate",
      "Run all agents directly against the working tree instead of one git worktree per task (default: isolated, commit + merge back)",
    )
    .option("--json", "Headless: stream JSONL task events instead of the live view", false)
    .action(
      async (
        goal: string[],
        opts: { concurrency: number; readonly: boolean; isolate: boolean; json: boolean },
      ) => {
        const { launchFleetView } = await import("./tui/fleet-view/index.js");
        const snap = await launchFleetView({
          cwd: process.cwd(),
          goal: goal.join(" ").trim() || undefined,
          concurrency: opts.concurrency,
          readOnly: opts.readonly,
          isolate: opts.isolate,
          headless: opts.json,
        });
        // Non-zero exit when anything failed, so scripts/CI can branch on it.
        if (snap.failedCount > 0) process.exitCode = 1;
      },
    );

  // ── solve: best-of-N task solving ───────────────────────────────────────────

  program
    .command("solve")
    .description("Solve a task best-of-N — run N candidates in parallel, keep the winner")
    .argument("<prompt...>", "The task to solve")
    .option("-n, --candidates <n>", "How many candidates to run (default 3, max 10)", (v) => parseInt(v, 10))
    .option("--verify <cmd>", "Command run in each candidate; its output decides the winner (e.g. 'pnpm test:unit')")
    .option("--models <slugs>", "Comma-separated gateway slugs cycled across candidates for diversity")
    .option("--selector <slug>", "Model that picks the winning candidate")
    .option("-m, --model <slug>", "Pin every candidate to one model")
    .option("--readonly", "Read-only candidates: do not apply a winner", false)
    .option("--json", "Headless: stream JSONL events instead of the live view", false)
    .option(
      "--pipeline",
      "Run each candidate through the full evaluate/enhance/judge/revise pipeline, not just bare " +
        "(default: OXAGEN_BEST_OF_N_PIPELINE env var if set, else bare — the selector still judges across all N either way)",
    )
    .option(
      "--verify-auto",
      "Union the test/lint/build commands every candidate actually ran and re-run them in every " +
        "surviving candidate's worktree before selection, so the selector's tests-pass signal is real, " +
        "executed evidence across the whole pool (default: OXAGEN_BEST_OF_N_VERIFY env var if set, else off)",
    )
    .action(
      async (
        promptWords: string[],
        opts: {
          candidates?: number;
          verify?: string;
          models?: string;
          selector?: string;
          model?: string;
          readonly?: boolean;
          json?: boolean;
          pipeline?: boolean;
          verifyAuto?: boolean;
        },
      ) => {
        const prompt = promptWords.join(" ").trim();
        if (!prompt) {
          process.stderr.write("Error: solve requires a task, e.g. `oxagen solve \"fix the failing test\"`.\n");
          process.exitCode = 1;
          return;
        }
        const { handleSolve } = await import("./commands/solve.js");
        await handleSolve(prompt, opts);
      },
    );

  // ── daemon: context daemon lifecycle ────────────────────────────────────────

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

  // ── replay: inspect how a past turn was handled ─────────────────────────────

  program
    .command("replay")
    .description("Show how a past turn was handled (prompt, scores, context, model, judge)")
    .argument("[turn]", "Turn index (1 = most recent) or id; omit for the latest")
    .option("--list", "List recent turns instead of replaying one", false)
    .action(async (turn: string | undefined, opts: { list?: boolean }) => {
      const { handleReplay } = await import("./commands/replay.js");
      await handleReplay(turn, opts);
    });

  // ── pr: watch a PR's CI, report, merge when green ───────────────────────────

  {
    const pr = program.command("pr").description("Watch a pull request's CI and merge it when green");
    pr
      .command("status")
      .description("One-shot CI verdict for a PR (exit 0 green / 1 failing / 2 pending)")
      .argument("[number]", "PR number; omit for the current branch's PR")
      .option("--json", "Output JSON", false)
      .action(async (number: string | undefined, opts: { json?: boolean }) => {
        const { handlePrStatus } = await import("./commands/pr.js");
        await handlePrStatus(number, opts);
      });
    pr
      .command("watch")
      .description("Stream a PR's CI until green or failing; offer to merge when green")
      .argument("[number]", "PR number; omit for the current branch's PR")
      .option("--merge", "Squash-merge automatically the moment it's green", false)
      .option("--interval <seconds>", "Poll interval seconds (default 30)", (v) => parseInt(v, 10))
      .option("--timeout <minutes>", "Give up after this many minutes (default 60)", (v) => parseInt(v, 10))
      .action(
        async (
          number: string | undefined,
          opts: { merge?: boolean; interval?: number; timeout?: number },
        ) => {
          const { handlePrWatch } = await import("./commands/pr.js");
          await handlePrWatch(number, opts);
        },
      );
    pr
      .command("fix")
      // The root's global `-m, --model` is reused (commander binds it to the
      // parent), so the action reads merged opts via optsWithGlobals().
      .description(
        "Actively fix a failing PR: diagnose, patch, push, repeat until green — then ask before merging",
      )
      .argument("[number]", "PR number; omit for the current branch's PR")
      .option("--max-rounds <n>", "Max fix attempts before giving up (default 3)", (v) => parseInt(v, 10))
      .option("--interval <seconds>", "Poll interval seconds while waiting on checks (default 30)", (v) =>
        parseInt(v, 10),
      )
      .option(
        "--timeout <minutes>",
        "Give up waiting on a single check run after this many minutes (default 60)",
        (v) => parseInt(v, 10),
      )
      .option("--yes", "Merge once green without an interactive prompt", false)
      .action(async (number: string | undefined, _opts, command: Command) => {
        const merged = command.optsWithGlobals() as {
          maxRounds?: number;
          interval?: number;
          timeout?: number;
          yes?: boolean;
          model?: string;
        };
        const { handlePrFix } = await import("./commands/pr.js");
        await handlePrFix(number, merged);
      });
  }

  // ── recover: find + restore agent work from the commit ledger ───────────────

  program
    .command("recover")
    .description("List or restore recorded agent commits (never lose work)")
    .argument("[hash]", "A commit hash to show restore instructions for; omit to list")
    .option("--all", "List across all repos, not just this one", false)
    .option("--json", "Output JSON", false)
    .action(async (hash: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const { handleRecover } = await import("./commands/recover.js");
      await handleRecover(hash, opts);
    });

  // ── cost: project + report model cost from the baked-in rate card ───────────

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

  program
    .command("trace")
    .argument("<executionId>", "Public ID (aex_…) or UUID of the execution")
    .description("Show an agent run as a span tree: steps, tool calls, and child executions")
    .option("--json", "Output the raw trace as JSON", false)
    .action(async (executionId: string, opts: { json?: boolean }) => {
      const { handleTrace } = await import("./commands/trace.js");
      await handleTrace(executionId, opts);
    });

  // ── models: on-device runtime + coordinator selection ───────────────────────

  const models = program
    .command("models")
    .description("Inspect and manage the model runtime (on-device + cloud)");
  models
    .command("list")
    .description("Show the registry, capability scores, and what fits this device")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { handleModelsList } = await import("./commands/models.js");
      await handleModelsList(opts);
    });
  models
    .command("active")
    .description("Show the current coordinator model and its kind (on-device | cloud)")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { handleModelsActive } = await import("./commands/models.js");
      await handleModelsActive(opts);
    });
  models
    .command("pull")
    .description("Download and cache the resolved on-device model weights")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { handleModelsPull } = await import("./commands/models.js");
      await handleModelsPull(opts);
    });
  models
    .command("status")
    .description("Show cache location, size, checksum state, and device fit")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { handleModelsStatus } = await import("./commands/models.js");
      await handleModelsStatus(opts);
    });
  models
    .command("use <id>")
    .description("Choose the coordinator model (on-device is always allowed)")
    .action(async (id: string) => {
      const { handleModelsUse } = await import("./commands/models.js");
      await handleModelsUse(id);
    });

  // ── graph: knowledge-graph search + pull + status ───────────────────────────

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

  graph
    .command("push")
    .description(
      "Compute a git code delta and push it to the workspace knowledge graph (ADR-018 up-sync)",
    )
    .option("--full", "Ignore the saved cursor and push all tracked source files", false)
    .option("--repo <id>", "Override the repo identifier")
    .option("--json", "Output summary as JSON")
    .action(async (opts: { full?: boolean; repo?: string; json?: boolean }) => {
      const { handleGraphPush } = await import("./commands/graph.push.js");
      await handleGraphPush({ full: opts.full, repo: opts.repo, json: opts.json });
    });

  graph
    .command("lineage")
    .description(
      "Push CLI session execution lineage into the workspace knowledge graph (ADR-018 slice 3)",
    )
    .option(
      "--repo <id>",
      "Override the repo identifier used to link touched files to the code subgraph",
    )
    .option("--json", "Output summary as JSON")
    .action(async (opts: { repo?: string; json?: boolean }) => {
      const { handleGraphLineage } = await import("./commands/graph.lineage.js");
      await handleGraphLineage({ repo: opts.repo, json: opts.json });
    });

  // ── a2a: Agent2Agent protocol surface ───────────────────────────────────────
  const a2a = program
    .command("a2a")
    .description("Inspect the workspace's Agent2Agent (A2A) protocol surface");
  a2a
    .command("card")
    .description(
      "Print the workspace's A2A Agent Card (exposed skills, transport endpoint, auth scheme)",
    )
    .option("--json", "Output the raw Agent Card JSON")
    .action(async (opts: { json?: boolean }) => {
      const { handleA2ACard } = await import("./commands/a2a.js");
      await handleA2ACard({ json: opts.json });
    });

  // ── memory: manage the workspace's agent memories ───────────────────────────

  const memory = program
    .command("memory")
    .description(
      "Manage the workspace's agent memories (list, show, edit, salience, promote, candidates, rm)",
    );
  memory
    .command("list")
    .description("List the workspace's memories, sorted by recency or citation count")
    .option("--class <memoryClass>", "Filter by epistemic class (OBSERVATION|RULE|FACT)")
    .option(
      "--kind <kind>",
      "Filter by content-domain kind (e.g. FEEDBACK, PERFORMANCE, constraint, gotcha)",
    )
    .option("--min-enforcement <n>", "Only rules at or above this enforcement score (1-100)")
    .option("--min-citations <n>", "Only memories cited at least this many times")
    .option("--sort <axis>", "Sort by 'createdAt' (recency, default) or 'citations'")
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
        opts: { lesson?: string; kind?: string; source?: string; json?: boolean },
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
    .option("--status <status>", "Lifecycle status (ACTIVE|SUPERSEDED|RETRACTED|ARCHIVED)")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: { confidence?: string; enforcement?: string; status?: string; json?: boolean },
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
    .option("--enforcement <n>", "Enforcement 1–100 to set for a RULE (ignored for FACT, forced 100)")
    .requiredOption("--rationale <text>", "Why this memory is being promoted")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: { to?: string; enforcement?: string; rationale?: string; json?: boolean },
      ) => {
        const { handleMemoryPromote } = await import("./commands/memory.js");
        await handleMemoryPromote(id, opts);
      },
    );
  memory
    .command("candidates")
    .description("List the top OBSERVATION memories by citation pressure ripe for promotion")
    .option("--limit <n>", "Max candidates (default 3)")
    .option("--json", "Output JSON")
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const { handleMemoryCandidates } = await import("./commands/memory.js");
      await handleMemoryCandidates(opts);
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
    .option("--class <memoryClass>", "Pin the epistemic class (OBSERVATION|RULE|FACT) instead of inferring it")
    .option("--kind <kind>", "Pin the content-domain kind instead of inferring it")
    .option("--enforcement <n>", "Enforcement 1–100 when --class is RULE")
    .option("--node <ref>", "Anchor the memory on a graph node ref")
    .option("--json", "Output JSON")
    .action(
      async (
        text: string[],
        opts: { class?: string; kind?: string; enforcement?: string; node?: string; json?: boolean },
      ) => {
        const { handleRemember } = await import("./commands/memory.js");
        await handleRemember(text.join(" "), opts);
      },
    );

  // ── code: code-map retrieval + diff/patch/format utilities ──────────────────

  const code = program
    .command("code")
    .description("Code utilities: semantic code-map retrieval, diff, patch, format");

  code
    .command("map <query>")
    .description(
      "Return a structured code-map for a natural-language concept: relevant files, " +
        "symbols, call edges, and recent commits. Faster than grep for conceptual queries.",
    )
    .option("-l, --limit <n>", "Max files to return (default 20)")
    .option("--kinds <list>", "Comma-separated result kinds: file,symbol,chunk,commit")
    .option("--domain <domain>", "Filter by domain label (e.g. billing, auth)")
    .option("--json", "Emit raw JSON output")
    .action(async (query: string, opts: { limit?: string; kinds?: string; domain?: string; json?: boolean }) => {
      const { handleCodeMap } = await import("./commands/code.js");
      await handleCodeMap(query, opts);
    });

  code
    .command("diff <before> <after>")
    .description("Produce a unified diff between two files")
    .option("--path <path>", "Path used in diff headers")
    .option("--context <n>", "Context lines (default 3)")
    .action(async (before: string, after: string, opts: { path?: string; context?: string }) => {
      const { handleCodeDiff } = await import("./commands/code.js");
      await handleCodeDiff(before, after, opts);
    });

  code
    .command("format <file>")
    .description("Format a source file by language")
    .option("--language <lang>", "Language (json, python)")
    .option("--indent <n>", "Indent size")
    .option("-w, --write", "Write formatted output back to file")
    .action(async (file: string, opts: { language?: string; indent?: string; write?: boolean }) => {
      const { handleCodeFormat } = await import("./commands/code.js");
      await handleCodeFormat(file, opts);
    });

  code
    .command("patch <diff-file>")
    .description("Apply a unified diff to a local workspace")
    .option("--dir <dir>", "Workspace root (default .)")
    .option("-w, --write", "Write patched files (dry-run without this flag)")
    .action(async (diffFile: string, opts: { dir?: string; write?: boolean }) => {
      const { handleCodePatch } = await import("./commands/code.js");
      await handleCodePatch(diffFile, opts);
    });

  // ── init: scaffold project + global settings, build code graph ──────────────

  program
    .command("init")
    .description(
      "Scaffold .oxagen/ project settings + global user settings, build the local code graph, " +
        "link the project to an Oxagen workspace, and print graph statistics + inferred domains",
    )
    .option("--json", "Output JSON instead of human-readable text")
    .option(
      "--no-link",
      "Skip the workspace linker step — only scaffold settings + build the code graph",
    )
    .action(async (opts: { json?: boolean; link?: boolean }) => {
      const { handleInit } = await import("./commands/init.js");
      await handleInit({ json: opts.json, noLink: opts.link === false });
    });

  // ── config: local CLI config (legacy) + Oxagen Workspace Config ─────────────
  //
  // Two surfaces share one Commander command: the legacy `[key] [value]` form
  // below (local CLI credentials/session — token/model/api-url/org/workspace)
  // and the structured, multi-scope subcommands registered after it (init/get/
  // set/add/remove/explain/build/lint/pull — docs/specs/oxagen-workspace-config/
  // design.md §7). Commander routes a first positional arg to a matching
  // subcommand when one exists and falls back to this action otherwise, so
  // `oxagen config token sk-…` and `oxagen config get vision.statement` both
  // resolve correctly — see the header comment in commands/config.ts.

  const config = program
    .command("config")
    .description("View or set configuration (api key, model, etc.)")
    .argument("[key]", "Config key to get/set")
    .argument("[value]", "Value to set (omit to read)")
    .action(async (key?: string, value?: string) => {
      const { handleConfig } = await import("./commands/config.js");
      await handleConfig(key, value);
    });

  config
    .command("init")
    .description("Write a starter workspace config file (default: workspace scope)")
    .option("--scope <scope>", "org | user | workspace | repo (default: workspace)")
    .action(async (opts: { scope?: string }) => {
      const { configInit } = await import("./commands/config.js");
      configInit(opts.scope);
    });
  config
    .command("get")
    .description("Print the merged value at a dotted path (e.g. vision.statement, commands.dev)")
    .argument("<path>", "Dotted config path")
    .action(async (path: string) => {
      const { configGet } = await import("./commands/config.js");
      configGet(path);
    });
  config
    .command("set")
    .description("Set a value at a dotted path in one scope")
    .argument("<path>", "Dotted config path")
    .argument("<value>", "Value to write (parsed as JSON when possible)")
    .option("--scope <scope>", "user | workspace | repo (default: workspace)")
    .action(async (path: string, value: string, opts: { scope?: string }) => {
      const { configSet } = await import("./commands/config.js");
      configSet(path, value, opts.scope);
    });
  config
    .command("add")
    .description("Add a rule/preference/policy/convention/reference for a language")
    .argument("<lang>", 'Language key, e.g. "typescript", "english"')
    .argument("<kind>", "rule | preference | policy | convention | reference")
    .argument("<text>", "Inline item text")
    .option("--scope <scope>", "user | workspace | repo (default: workspace)")
    .option("--id <id>", "Stable id (default: slugified from <text>)")
    .option("--doc <path>", "Path/URL to a doc with the full detail")
    .option("--enforced", "Surface in the agent's hard-rules section")
    .option("--locked", "Cannot be overridden or removed by a less-authoritative scope")
    .option("--source <source>", "File path / URL this item was derived from")
    .option("--confidence <n>", "0–1 confidence score (origin: research)")
    .action(
      async (
        lang: string,
        kind: string,
        text: string,
        opts: {
          scope?: string;
          id?: string;
          doc?: string;
          enforced?: boolean;
          locked?: boolean;
          source?: string;
          confidence?: string;
        },
      ) => {
        const { configAdd } = await import("./commands/config.js");
        configAdd(lang, kind, text, opts);
      },
    );
  config
    .command("remove")
    .description("Remove a language item by id")
    .argument("<id>", "Item id")
    .option("--scope <scope>", "user | workspace | repo (default: workspace)")
    .action(async (id: string, opts: { scope?: string }) => {
      const { configRemove } = await import("./commands/config.js");
      configRemove(id, opts.scope);
    });
  config
    .command("explain")
    .description("Report which scope wins at a dotted path, and why")
    .argument("<path>", "Dotted config path")
    .action(async (path: string) => {
      const { configExplain } = await import("./commands/config.js");
      configExplain(path);
    });
  config
    .command("build")
    .description("Scan sources (workspace + user) and write the consolidated capability index")
    .option("--live-mcp", "Best-effort live-connect to MCP servers to list their tools (slower, network-dependent)")
    .option("--json", "Print the consolidated index as JSON instead of a summary")
    .action(async (opts: { liveMcp?: boolean; json?: boolean }) => {
      const { configBuild } = await import("./commands/config.js");
      await configBuild(opts);
    });
  config
    .command("lint")
    .description("Validate every scope file against the schema and report consolidated-index drift")
    .action(async () => {
      const { configLint } = await import("./commands/config.js");
      await configLint();
    });
  config
    .command("doctor")
    .description("Scan the config tiers (repo ▸ workspace ▸ user ▸ org managed) for problems and recommendations")
    .action(async () => {
      const { configDoctor } = await import("./commands/config.js");
      await configDoctor();
    });
  config
    .command("pull")
    .description("Sync user.json (and org-provisioned managed.json) from the platform")
    .action(async () => {
      const { configPull } = await import("./commands/config.js");
      await configPull();
    });

  // ── logs: see + debug the OXAGEN_CLI_DEBUG .output stream ────────────────────

  program
    .command("logs")
    .description(
      "See and debug the CLI's log (~/.oxagen/logs/cli.output). Captures invocations, " +
        "LLM telemetry, and the lineage + code-graph data synced to the workspace graph " +
        "when OXAGEN_CLI_DEBUG=1.",
    )
    .option("--path", "Print the log file path and exit", false)
    .option("-n, --lines <n>", "Number of recent entries to show (default 50)")
    .option(
      "--category <category>",
      "Filter by category: invoke | turn | api | code-graph | graph-sync | llm | error",
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

  // ── login / logout: platform authentication ─────────────────────────────────

  program
    .command("login")
    .description(
      "Authenticate the CLI — opens a browser by default (interactive). Use --token for CI/headless.",
    )
    .option("--token <token>", "Platform API token — skips browser login (CI/headless)")
    .option("--org <slug>", "Organization slug (required with --token)")
    .option("--workspace <slug>", "Workspace slug (required with --token)")
    .option("--no-browser", "Prompt for token instead of opening the browser")
    .action(
      async (opts: { token?: string; org?: string; workspace?: string; browser?: boolean }) => {
        const { handleLogin } = await import("./commands/auth.js");
        await handleLogin(opts);
      },
    );

  program
    .command("logout")
    .description("Clear the stored Oxagen session from ~/.config/oxagen/config.json.")
    .action(async () => {
      const { handleLogout } = await import("./commands/auth.js");
      handleLogout();
    });

  // ── settings: the unified settings.json driver ──────────────────────────────

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

  // ── agent: named agent definitions ──────────────────────────────────────────

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

  // ── command: user-defined slash commands ────────────────────────────────────

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

  // ── rules: workspace rules the agent must follow ────────────────────────────

  const rules = program
    .command("rules")
    .description(
      "Manage workspace rules the agent is told about and hard-blocked from violating (list, show, new, check, candidates, promote)",
    );
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
  rules
    .command("candidates")
    .description(
      "Mine recurring lessons from local thinking logs + fleet memory into rule promotion candidates",
    )
    .option("--limit <n>", "Max candidates (default 10)")
    .option("--json", "Output JSON")
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const { rulesCandidates } = await import("./commands/rules.js");
      rulesCandidates(opts);
    });
  rules
    .command("promote <id>")
    .description(
      "Promote a mined candidate (from `rules candidates`) to an enforced .oxagen/rules/<id>.md — never writes without --yes",
    )
    .option("-y, --yes", "Write the rule (default previews only — never auto-writes)")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const { rulesPromote } = await import("./commands/rules.js");
      rulesPromote(id, opts);
    });

  // ── mcp: external MCP servers ───────────────────────────────────────────────

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

  // ── env: workspace environments ─────────────────────────────────────────────

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

  // ── eval: datasets + runs (eval.* capabilities) ─────────────────────────────

  const evalCmd = program
    .command("eval")
    .description("Evaluate datasets against models/agents with an LLM judge");

  evalCmd
    .command("datasets")
    .description("List eval datasets in the active workspace")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const { evalDatasetList } = await import("./commands/eval.js");
      await evalDatasetList(opts);
    });
  evalCmd
    .command("dataset <id>")
    .description("Show one eval dataset and a page of its items")
    .option("--limit <n>", "Page size (1-200, default 50)")
    .option("--cursor <cursor>", "Opaque cursor from a previous page's nextCursor")
    .option("--json", "Output JSON")
    .action(
      async (id: string, opts: { limit?: string; cursor?: string; json?: boolean }) => {
        const { evalDatasetGet } = await import("./commands/eval.js");
        await evalDatasetGet(id, {
          limit: opts.limit ? Number(opts.limit) : undefined,
          cursor: opts.cursor,
          json: opts.json,
        });
      },
    );
  evalCmd
    .command("dataset-create <name>")
    .description("Create an empty eval dataset")
    .option("--slug <slug>", "Slug (defaults to a slugified name)")
    .option("--description <text>", "Description")
    .option("--json", "Output JSON")
    .action(
      async (
        name: string,
        opts: { slug?: string; description?: string; json?: boolean },
      ) => {
        const { evalDatasetCreate } = await import("./commands/eval.js");
        await evalDatasetCreate(name, opts);
      },
    );
  evalCmd
    .command("dataset-item-add <id>")
    .description("Bulk-add cases to an eval dataset")
    .option("--input <text>", "Prompt/question for a single item")
    .option("--expected <text>", "Known-good answer for the single item")
    .option("--metadata <json>", "JSON object of metadata for the single item")
    .option("--file <path>", "Path to a JSON file containing an array of items")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: {
          input?: string;
          expected?: string;
          metadata?: string;
          file?: string;
          json?: boolean;
        },
      ) => {
        const { evalDatasetItemAdd } = await import("./commands/eval.js");
        await evalDatasetItemAdd(id, opts);
      },
    );
  evalCmd
    .command("from-traces <name>")
    .description(
      "Create an eval dataset from real, already-metered production traces — score what actually ran",
    )
    .option("--slug <slug>", "Slug (defaults to a slugified name)")
    .option("--description <text>", "Description")
    .option("--capability <name>", "Only sample runs whose metered capability matches (e.g. chat.message.send)")
    .option("--since-hours <n>", "Lookback window over metered traces (default 168 = 7 days)")
    .option("--limit <n>", "Cap on captured cases (default 50, max 500)")
    .option("--json", "Output JSON")
    .action(
      async (
        name: string,
        opts: {
          slug?: string;
          description?: string;
          capability?: string;
          sinceHours?: string;
          limit?: string;
          json?: boolean;
        },
      ) => {
        const { evalDatasetFromTraces } = await import("./commands/eval.js");
        await evalDatasetFromTraces(name, {
          slug: opts.slug,
          description: opts.description,
          capability: opts.capability,
          sinceHours: opts.sinceHours ? Number(opts.sinceHours) : undefined,
          limit: opts.limit ? Number(opts.limit) : undefined,
          json: opts.json,
        });
      },
    );
  evalCmd
    .command("run <datasetId>")
    .description("Start an eval run against a dataset (async — poll run-status/run-get for results)")
    .option("--model <slug>", "Gateway model slug for the target (omit for the default tier)")
    .option("--system-prompt <text>", "System prompt prepended to each item's input")
    .option("--agent <slug>", "Evaluate a workspace agent instead of a bare model")
    .option("--judge-model <slug>", "Gateway model slug for the judge (omit for the precise tier)")
    .option("--name <text>", "Optional label for the run")
    .option("--pass-threshold <n>", "Overall judge score (0-1) at/above which an item passes (default 0.7)")
    .option("--max-items <n>", "Cap items evaluated this run (cost control); omit for all items")
    .option("--json", "Output JSON")
    .action(
      async (
        datasetId: string,
        opts: {
          model?: string;
          systemPrompt?: string;
          agent?: string;
          judgeModel?: string;
          name?: string;
          passThreshold?: string;
          maxItems?: string;
          json?: boolean;
        },
      ) => {
        const { evalRunStart } = await import("./commands/eval.js");
        await evalRunStart(datasetId, {
          model: opts.model,
          systemPrompt: opts.systemPrompt,
          agent: opts.agent,
          judgeModel: opts.judgeModel,
          name: opts.name,
          passThreshold: opts.passThreshold ? Number(opts.passThreshold) : undefined,
          maxItems: opts.maxItems ? Number(opts.maxItems) : undefined,
          json: opts.json,
        });
      },
    );
  evalCmd
    .command("run-status <runId>")
    .description("Poll an eval run's lifecycle: status, progress counts, and mean score")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { evalRunStatus } = await import("./commands/eval.js");
      await evalRunStatus(runId, opts);
    });
  evalCmd
    .command("run-get <runId>")
    .description("Fetch an eval run's summary and full per-item results")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { evalRunGet } = await import("./commands/eval.js");
      await evalRunGet(runId, opts);
    });

  // ── secret: credential vault ────────────────────────────────────────────────

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

  return program;
}
