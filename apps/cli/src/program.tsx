/**
 * program.ts — The Commander command tree for the `oxagen` CLI.
 *
 * Extracted from index.tsx so the exact same command set that drives
 * `oxagen --help` is the single source of truth for the REPL's slash-command
 * menu (see slash/catalog.ts + commands/meta.ts describeCliCommands). Building
 * the program has no side effects — every handler is a dynamic `import()`
 * inside its action — so the REPL can construct it purely to introspect
 * command names + descriptions without running anything. Command-tree
 * introspection helpers live in commands/meta.ts so leaf modules never need
 * to import this composition root.
 */
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { parseModeArg, type PermissionMode } from "./agent/permissions.js";

const { version } = pkg;

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

/**
 * Commander reducer for a repeatable option: accumulate each occurrence into an
 * array (e.g. `--env-var A=1 --env-var B=2` → `["A=1", "B=2"]`). Pairs are
 * validated in the command handler, not here.
 */
function collectPair(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Construct the full `oxagen` command tree. Pure: no parsing, no I/O, no
 * side effects — `index.tsx` parses it, the REPL only introspects it.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("oxagen")
    .description(
      "Agentic coding assistant — powered by the Oxagen context engine",
    )
    .version(version)
    .argument("[prompt...]", "One-shot prompt (runs and exits)")
    .option(
      "-m, --model <slug>",
      "Worker (executor) model slug (overrides config/default)",
    )
    .option(
      "--worker-model <slug>",
      "Worker (executor) model slug — alias for --model",
    )
    .option("--judge-model <slug>", "Judge (completeness advisor) model slug")
    .option(
      "--triage-model <slug>",
      "Triage/coordinator (planner + evaluator) model slug",
    )
    .option(
      "--effort <level>",
      "Reasoning effort for models that support it: low | medium | high | xhigh | max (omit = model default / adaptive)",
    )
    .option(
      "--agent <name>",
      "Run the one-shot prompt as a named agent definition",
    )
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
    .option(
      "--budget <usd>",
      "Enable a per-turn dollar budget, e.g. --budget 2.50 (session-scoped; unset = unbounded)",
    )
    .option(
      "--budget-mode <mode>",
      "What happens at the budget limit: grace | prompt | enforce (default: prompt; ignored without --budget)",
    )
    .action(
      async (
        promptWords: string[],
        opts: {
          model?: string;
          workerModel?: string;
          judgeModel?: string;
          triageModel?: string;
          effort?: string;
          readonly?: boolean;
          mode?: string;
          local?: boolean;
          pipeline?: boolean;
          verbose?: boolean;
          agent?: string;
          outputFormat?: string;
          maxSteps?: string;
          budget?: string;
          budgetMode?: string;
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
        // --budget/--budget-mode: a per-turn dollar budget, session-scoped (no
        // platform persistence — the CLI runs BYOK/offline). Dynamic import so
        // @oxagen/billing only loads when the flag is actually used, matching
        // this file's "no side effects until an action runs" contract.
        let budget:
          | import("@oxagen/billing/turn-budget").TurnBudgetPolicy
          | undefined;
        if (opts.budget !== undefined) {
          const { resolveBudgetFlags } = await import("./agent/budget.js");
          const resolved = resolveBudgetFlags(opts.budget, opts.budgetMode);
          if (resolved.error) {
            process.stderr.write(`Error: ${resolved.error}\n`);
            process.exitCode = 1;
            return;
          }
          budget = resolved.policy;
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
          // Worker: --worker-model is a synonym for -m/--model (the executor).
          model: opts.workerModel ?? opts.model,
          judgeModel: opts.judgeModel,
          triageModel: opts.triageModel,
          effort: opts.effort,
          readOnly: opts.readonly,
          mode,
          bare: opts.pipeline === false,
          verbose: opts.verbose,
          outputFormat,
          maxSteps,
          budget,
        };

        // Feed the anonymous usage-telemetry accumulator (index.tsx emits the
        // event after this action resolves): pipeline_used and byok are known
        // right here from data already destructured above, so record them
        // directly rather than re-deriving them generically at the exit hook.
        {
          const { markPipelineUsed, setByok } = await import(
            "./telemetry/usage.js"
          );
          markPipelineUsed(!runOpts.bare);
          setByok(session.orgSlug === "local");
        }

        // --agent: run the prompt as a named agent (its prompt, tools, model).
        if (opts.agent) {
          if (!prompt) {
            process.stderr.write(
              'Error: --agent requires a prompt, e.g. `oxagen --agent reviewer "…"`.\n',
            );
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
          // Interactive REPL mode. The import below drags in Ink, the agent
          // engine, and native DuckDB/onnxruntime modules — seconds cold, far
          // longer on a loaded machine — during which nothing else paints, so
          // animate a dependency-free splash until the REPL can own the screen.
          const { startStartupSplash } = await import(
            "./tui/startup-splash.js"
          );
          const splash = startStartupSplash();
          let repl: typeof import("./repl/interactive.js");
          try {
            repl = await import("./repl/interactive.js");
          } finally {
            // Stop before launchRepl: the REPL enters the alternate screen
            // buffer, and the splash line must be gone from the primary buffer
            // first (an import error must also never strand a spinner frame).
            splash.stop();
          }
          // Inject the program factory: the REPL introspects/dispatches CLI
          // commands through it without ever importing this composition root.
          await repl.launchRepl({ ...runOpts, buildProgram });
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
    .description("Audit agent work — recent runs, cost, code-graph, and health")
    .action(async () => {
      const { launchAgentView } = await import("./tui/agent-view/index.js");
      await launchAgentView({ cwd: process.cwd() });
    });

  // ── agents: the agents screen (fleet) ───────────────────────────────────────

  program
    .command("agents")
    .description(
      "Launch the agents screen — plan a goal, dispatch a fleet, watch it work",
    )
    .argument("[goal...]", "Goal to plan into tasks and run immediately")
    .option(
      "--concurrency <n>",
      "Max agents running at once",
      (v) => parseInt(v, 10),
      4,
    )
    .option(
      "--readonly",
      "Read-only agents: read/search/explain only — no file edits or commands",
      false,
    )
    .option(
      "--no-isolate",
      "Run all agents directly against the working tree instead of one git worktree per task (default: isolated, commit + merge back)",
    )
    .option(
      "--json",
      "Headless: stream JSONL task events instead of the live view",
      false,
    )
    .action(
      async (
        goal: string[],
        opts: {
          concurrency: number;
          readonly: boolean;
          isolate: boolean;
          json: boolean;
        },
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
    .description(
      "Solve a task best-of-N — run N candidates in parallel, keep the winner",
    )
    .argument("<prompt...>", "The task to solve")
    .option(
      "-n, --candidates <n>",
      "How many candidates to run (default 3, max 10)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--verify <cmd>",
      "Command run in each candidate; its output decides the winner (e.g. 'pnpm test:unit')",
    )
    .option(
      "--models <slugs>",
      "Comma-separated gateway slugs cycled across candidates for diversity",
    )
    .option("--selector <slug>", "Model that picks the winning candidate")
    .option("-m, --model <slug>", "Pin every candidate to one model")
    .option("--readonly", "Read-only candidates: do not apply a winner", false)
    .option(
      "--json",
      "Headless: stream JSONL events instead of the live view",
      false,
    )
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
          process.stderr.write(
            'Error: solve requires a task, e.g. `oxagen solve "fix the failing test"`.\n',
          );
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
    .option("--json", "Output the start result as JSON", false)
    .action(async (opts: { foreground: boolean; json: boolean }) => {
      const { startDaemon } = await import("./daemon/lifecycle.js");
      await startDaemon({ foreground: opts.foreground, json: opts.json });
    });

  daemon
    .command("stop")
    .description("Stop the running context daemon")
    .option("--json", "Output the stop result as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { stopDaemon } = await import("./daemon/lifecycle.js");
      await stopDaemon({ json: opts.json });
    });

  daemon
    .command("status")
    .description("Show daemon health and uptime")
    .option("--json", "Output the health envelope as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { daemonStatus } = await import("./daemon/lifecycle.js");
      await daemonStatus({ json: opts.json });
    });

  const daemonSession = daemon
    .command("session")
    .description(
      "Inspect and fork the daemon's recorded compile sessions (in-memory event log, resets on restart)",
    );

  daemonSession
    .command("list")
    .description("List sessions recorded by the running daemon")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json: boolean }) => {
      const { sessionList } = await import("./daemon/lifecycle.js");
      await sessionList(opts);
    });

  daemonSession
    .command("fork")
    .description("Fork a recorded session at a given event index")
    .argument("<sessionId>", "Session ID to fork from")
    .argument("<forkPoint>", "Event index to fork at (integer)")
    .option("--json", "Output JSON", false)
    .action(
      async (
        sessionId: string,
        forkPointArg: string,
        opts: { json: boolean },
      ) => {
        const forkPoint = parseInt(forkPointArg, 10);
        if (Number.isNaN(forkPoint)) {
          process.stderr.write(
            `Invalid fork point "${forkPointArg}". Use an integer event index.\n`,
          );
          process.exitCode = 1;
          return;
        }
        const { sessionFork } = await import("./daemon/lifecycle.js");
        await sessionFork(sessionId, forkPoint, opts);
      },
    );

  daemonSession
    .command("replay")
    .description(
      "Check a recorded session's determinism and print its per-turn metrics",
    )
    .argument("<sessionId>", "Session ID to replay")
    .option("--json", "Output JSON", false)
    .action(async (sessionId: string, opts: { json: boolean }) => {
      const { sessionReplay } = await import("./daemon/lifecycle.js");
      await sessionReplay(sessionId, opts);
    });

  // ── replay: inspect how a past turn was handled ─────────────────────────────

  program
    .command("replay")
    .description(
      "Show how a past turn was handled (prompt, scores, context, model, judge)",
    )
    .argument(
      "[turn]",
      "Turn index (1 = most recent) or id; omit for the latest",
    )
    .option("--list", "List recent turns instead of replaying one", false)
    .action(async (turn: string | undefined, opts: { list?: boolean }) => {
      const { handleReplay } = await import("./commands/replay.js");
      await handleReplay(turn, opts);
    });

  // ── pr: watch a PR's CI, report, merge when green ───────────────────────────

  {
    const pr = program
      .command("pr")
      .description("Watch a pull request's CI and merge it when green");
    pr.command("status")
      .description(
        "One-shot CI verdict for a PR (exit 0 green / 1 failing / 2 pending)",
      )
      .argument("[number]", "PR number; omit for the current branch's PR")
      .option("--json", "Output JSON", false)
      .action(async (number: string | undefined, opts: { json?: boolean }) => {
        const { handlePrStatus } = await import("./commands/pr.js");
        await handlePrStatus(number, opts);
      });
    pr.command("watch")
      .description(
        "Stream a PR's CI until green or failing; offer to merge when green",
      )
      .argument("[number]", "PR number; omit for the current branch's PR")
      .option(
        "--merge",
        "Squash-merge automatically the moment it's green",
        false,
      )
      .option(
        "--interval <seconds>",
        "Poll interval seconds (default 30)",
        (v) => parseInt(v, 10),
      )
      .option(
        "--timeout <minutes>",
        "Give up after this many minutes (default 60)",
        (v) => parseInt(v, 10),
      )
      .action(
        async (
          number: string | undefined,
          opts: { merge?: boolean; interval?: number; timeout?: number },
        ) => {
          const { handlePrWatch } = await import("./commands/pr.js");
          await handlePrWatch(number, opts);
        },
      );
    pr.command("fix")
      // The root's global `-m, --model` is reused (commander binds it to the
      // parent), so the action reads merged opts via optsWithGlobals().
      .description(
        "Actively fix a failing PR: diagnose, patch, push, repeat until green — then ask before merging",
      )
      .argument("[number]", "PR number; omit for the current branch's PR")
      .option(
        "--max-rounds <n>",
        "Max fix attempts before giving up (default 3)",
        (v) => parseInt(v, 10),
      )
      .option(
        "--interval <seconds>",
        "Poll interval seconds while waiting on checks (default 30)",
        (v) => parseInt(v, 10),
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
    .argument(
      "[hash]",
      "A commit hash to show restore instructions for; omit to list",
    )
    .option("--all", "List across all repos, not just this one", false)
    .option("--json", "Output JSON", false)
    .action(
      async (
        hash: string | undefined,
        opts: { all?: boolean; json?: boolean },
      ) => {
        const { handleRecover } = await import("./commands/recover.js");
        await handleRecover(hash, opts);
      },
    );

  // ── cost: project + report model cost from the baked-in rate card ───────────

  program
    .command("cost")
    // The root's global `-m, --model` is reused (commander binds it to the parent),
    // so the action reads merged opts via optsWithGlobals() to see --model here.
    .description(
      "Project model cost from the baked-in rate card, or roll up this project's spend",
    )
    .option("--in <tokens>", "Input token count to price", (v) =>
      parseInt(v, 10),
    )
    .option("--out <tokens>", "Output token count to price", (v) =>
      parseInt(v, 10),
    )
    .option("--rates", "Print the baked-in rate card", false)
    .option(
      "--session",
      "Roll up what this project's recorded turns actually cost, by model",
      false,
    )
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
    .description(
      "Show an agent run as a span tree: steps, tool calls, and child executions",
    )
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
    .description(
      "Show the registry, capability scores, and what fits this device",
    )
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const { handleModelsList } = await import("./commands/models.js");
      await handleModelsList(opts);
    });
  models
    .command("active")
    .description(
      "Show the current coordinator model and its kind (on-device | cloud)",
    )
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

  const graph = program
    .command("graph")
    .description("Query the knowledge graph");
  graph
    .command("search")
    .description(
      "Unified semantic (vector) search across the entire knowledge graph",
    )
    .requiredOption(
      "-q, --query <text>",
      "Natural-language query to search by vector similarity",
    )
    .option(
      "-k, --kinds <kinds>",
      "Comma-separated node kinds (entity,file,symbol,chunk,memory,execution,document,message)",
    )
    .option(
      "-l, --labels <labels>",
      "Comma-separated domain labels (e.g. Person,SourceFile)",
    )
    .option("-n, --limit <n>", "Maximum number of results (1–50)", "10")
    .option("--system", "Only return product-owned (system) nodes")
    .option("--no-system", "Only return customer nodes (exclude system nodes)")
    .option(
      "--json",
      "One machine JSON line (also the default when stdout is piped)",
      false,
    )
    .option("--quiet", "Suppress progress chrome (stderr)", false)
    .action(
      async (opts: {
        query: string;
        kinds?: string;
        labels?: string;
        limit?: string;
        system?: boolean;
      }) => {
        const { handleGraphSearch } = await import(
          "./commands/graph.search.js"
        );
        await handleGraphSearch(opts);
      },
    );

  graph
    .command("pull")
    .description(
      "Download an incremental snapshot of the workspace graph into a local DuckDB replica",
    )
    .option(
      "--full",
      "Ignore the saved cursor and re-pull the entire graph",
      false,
    )
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
    .option(
      "--full",
      "Ignore the saved cursor and push all tracked source files",
      false,
    )
    .option("--repo <id>", "Override the repo identifier")
    .option("--json", "Output summary as JSON")
    .action(async (opts: { full?: boolean; repo?: string; json?: boolean }) => {
      const { handleGraphPush } = await import("./commands/graph.push.js");
      await handleGraphPush({
        full: opts.full,
        repo: opts.repo,
        json: opts.json,
      });
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
      const { handleGraphLineage } = await import(
        "./commands/graph.lineage.js"
      );
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

  // ── file-lock: manual acquire/release/introspection over agent file locks ──
  const fileLock = program
    .command("file-lock")
    .description(
      "Inspect or manage the workspace's agent file locks (HOLDS_LOCK edges) — the same locks write_file/edit_file acquire automatically",
    );
  fileLock
    .command("list")
    .description(
      "List every currently-live file lock in the workspace, optionally filtered to one file",
    )
    .option("--path <path>", "File path (or naturalKey) to filter to")
    .option(
      "--owner <owner>",
      "GitHub owner — combined with --repo + --path to derive the naturalKey filter",
    )
    .option("--repo <repo>", "GitHub repo — see --owner")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        path?: string;
        owner?: string;
        repo?: string;
        json?: boolean;
      }) => {
        const { handleFileLockList } = await import("./commands/file-lock.js");
        await handleFileLockList(opts);
      },
    );
  fileLock
    .command("acquire <path>")
    .description(
      "Acquire (or renew) an exclusive, TTL-bounded lock on a file so no two agents edit it concurrently",
    )
    .option(
      "--owner <owner>",
      "GitHub owner — combined with --repo to derive the naturalKey",
    )
    .option("--repo <repo>", "GitHub repo — see --owner")
    .option(
      "--action <action>",
      "Free-text action label stored on the lock edge: read|write (default write)",
    )
    .option(
      "--ttl-ms <n>",
      "Lease length in ms (default 300000 = 5 minutes; capped at 1 hour)",
    )
    .option(
      "--agent-id <id>",
      "Identity to hold the lock as (default: the calling user/api-key id)",
    )
    .option(
      "--execution-id <id>",
      "Correlates this lock for a later batch/manual release",
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        path: string,
        opts: {
          owner?: string;
          repo?: string;
          action?: string;
          ttlMs?: string;
          agentId?: string;
          executionId?: string;
          json?: boolean;
        },
      ) => {
        const { handleFileLockAcquire } = await import(
          "./commands/file-lock.js"
        );
        await handleFileLockAcquire(path, opts);
      },
    );
  fileLock
    .command("release <lockId>")
    .description(
      "Force-release a file lock by its lockId — for clearing a lock a crashed/stuck agent left behind",
    )
    .option("--json", "Output as JSON")
    .action(async (lockId: string, opts: { json?: boolean }) => {
      const { handleFileLockRelease } = await import("./commands/file-lock.js");
      await handleFileLockRelease(lockId, opts);
    });

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

  // ── code: code-map retrieval + diff/patch/format utilities ──────────────────

  const code = program
    .command("code")
    .description(
      "Code utilities: semantic code-map retrieval, diff, patch, format",
    );

  code
    .command("map <query>")
    .description(
      "Return a structured code-map for a natural-language concept: relevant files, " +
        "symbols, call edges, and recent commits. Faster than grep for conceptual queries.",
    )
    .option("-l, --limit <n>", "Max files to return (default 20)")
    .option(
      "--kinds <list>",
      "Comma-separated result kinds: file,symbol,chunk,commit",
    )
    .option("--domain <domain>", "Filter by domain label (e.g. billing, auth)")
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        query: string,
        opts: {
          limit?: string;
          kinds?: string;
          domain?: string;
          json?: boolean;
        },
      ) => {
        const { handleCodeMap } = await import("./commands/code.js");
        await handleCodeMap(query, opts);
      },
    );

  code
    .command("diff <before> <after>")
    .description("Produce a unified diff between two files")
    .option("--path <path>", "Path used in diff headers")
    .option("--context <n>", "Context lines (default 3)")
    .action(
      async (
        before: string,
        after: string,
        opts: { path?: string; context?: string },
      ) => {
        const { handleCodeDiff } = await import("./commands/code.js");
        await handleCodeDiff(before, after, opts);
      },
    );

  code
    .command("format <file>")
    .description("Format a source file by language")
    .option("--language <lang>", "Language (json, python)")
    .option("--indent <n>", "Indent size")
    .option("-w, --write", "Write formatted output back to file")
    .action(
      async (
        file: string,
        opts: { language?: string; indent?: string; write?: boolean },
      ) => {
        const { handleCodeFormat } = await import("./commands/code.js");
        await handleCodeFormat(file, opts);
      },
    );

  code
    .command("patch <diff-file>")
    .description("Apply a unified diff to a local workspace")
    .option("--dir <dir>", "Workspace root (default .)")
    .option("-w, --write", "Write patched files (dry-run without this flag)")
    .action(
      async (diffFile: string, opts: { dir?: string; write?: boolean }) => {
        const { handleCodePatch } = await import("./commands/code.js");
        await handleCodePatch(diffFile, opts);
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

  // ── sandbox: durable code-agent sandbox utilities ───────────────────────────

  const sandbox = program
    .command("sandbox")
    .description("Inspect durable code-agent sandbox sessions");

  sandbox
    .command("list")
    .description("List the durable sandbox sessions in the active workspace")
    .option(
      "--status <status>",
      "Filter by lifecycle status: running | idle | stopped | gone",
    )
    .option("--limit <n>", "Max sessions to return (1-100, default 50)")
    .option("--json", "Emit raw JSON output")
    .action(
      async (opts: { status?: string; limit?: string; json?: boolean }) => {
        const { handleSandboxList } = await import("./commands/sandbox.js");
        await handleSandboxList(opts);
      },
    );

  sandbox
    .command("files <session-id>")
    .description(
      "List files/directories inside a durable sandbox session's workspace",
    )
    .option(
      "--path <path>",
      "Workspace-relative directory to list (default root)",
    )
    .option("--depth <n>", "Max recursion depth 1-5 (default 2)")
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        sessionId: string,
        opts: { path?: string; depth?: string; json?: boolean },
      ) => {
        const { handleSandboxFiles } = await import("./commands/sandbox.js");
        await handleSandboxFiles(sessionId, opts);
      },
    );

  sandbox
    .command("cat <session-id> <path>")
    .description(
      "Print one file's contents from a durable sandbox session's workspace",
    )
    .option("--max-bytes <n>", "Max bytes to read (default 256 KiB, cap 1 MiB)")
    .option("--json", "Emit raw JSON output (includes base64 for binary files)")
    .action(
      async (
        sessionId: string,
        path: string,
        opts: { maxBytes?: string; json?: boolean },
      ) => {
        const { handleSandboxCat } = await import("./commands/sandbox.js");
        await handleSandboxCat(sessionId, path, opts);
      },
    );

  sandbox
    .command("logs <session-id>")
    .description(
      "Print captured stdout/stderr/command output for a durable sandbox session",
    )
    .option(
      "--debug",
      "Include debug lines (command echoes, timings, plumbing); off by default",
    )
    .option("--limit <n>", "Max lines to return (1-2000, default 500)")
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        sessionId: string,
        opts: { debug?: boolean; limit?: string; json?: boolean },
      ) => {
        const { handleSandboxLogs } = await import("./commands/sandbox.js");
        await handleSandboxLogs(sessionId, opts);
      },
    );

  sandbox
    .command("warm")
    .description(
      "Provision (or reuse) a durable code-agent sandbox, optionally cloning repos into it",
    )
    .option(
      "--session-key <key>",
      "Stable reuse key to warm one sandbox across turns (omit for a fresh session)",
    )
    .option("--label <label>", "Human-friendly name shown in the sandbox list")
    .option(
      "--image <image>",
      "Base image: node | python | shell | agent (default agent)",
    )
    .option(
      "--repo <owner/name[#branch]>",
      "Repository to clone into the sandbox at provision time (repeatable, max 8)",
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[],
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (opts: {
        sessionKey?: string;
        label?: string;
        image?: string;
        repo?: string[];
        json?: boolean;
      }) => {
        const { handleSandboxWarm } = await import("./commands/sandbox.js");
        await handleSandboxWarm(opts);
      },
    );

  sandbox
    .command("rename <session-id> <label>")
    .description("Set a durable sandbox session's human-friendly display label")
    .option("--json", "Emit raw JSON output")
    .action(
      async (sessionId: string, label: string, opts: { json?: boolean }) => {
        const { handleSandboxRename } = await import("./commands/sandbox.js");
        await handleSandboxRename(sessionId, label, opts);
      },
    );

  // ── sandbox template: portable sandbox-template CRUD + export/import ─────────

  const sandboxTemplate = sandbox
    .command("template")
    .description(
      "Manage portable sandbox templates (config + tools + secret key names)",
    );

  sandboxTemplate
    .command("list")
    .description(
      "List sandbox templates, optionally filtered to one environment",
    )
    .option("--env <slug>", "Filter to one environment (slug or env_ id)")
    .option("--json", "Emit raw JSON output")
    .action(async (opts: { env?: string; json?: boolean }) => {
      const { handleTemplateList } = await import(
        "./commands/sandbox-template.js"
      );
      await handleTemplateList(opts);
    });

  sandboxTemplate
    .command("get <slug-or-id>")
    .description(
      "Show one sandbox template with its resources, network, and tools",
    )
    .option(
      "--env <slug>",
      "Environment to disambiguate a slug (slug or env_ id)",
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (slugOrId: string, opts: { env?: string; json?: boolean }) => {
        const { handleTemplateGet } = await import(
          "./commands/sandbox-template.js"
        );
        await handleTemplateGet(slugOrId, opts);
      },
    );

  sandboxTemplate
    .command("create")
    .description("Create a sandbox template under an environment")
    .requiredOption(
      "--env <slug>",
      "Environment to create it in (slug or env_ id)",
    )
    .requiredOption("--name <name>", "Human-readable template name")
    .requiredOption(
      "--slug <slug>",
      "Workspace-unique handle (e.g. swe-bench-prewarmed)",
    )
    .option("--description <text>", "Optional description")
    .option("--provider <provider>", "modal | vercel | docker (default modal)")
    .option(
      "--runtime <ref>",
      "Image ref (digest-pinned encouraged) or language tag",
    )
    .option("--vcpu <n>", "vCPU count (1-4)")
    .option("--memory-mb <n>", "Memory in MiB (≤8192)")
    .option("--timeout-ms <n>", "Run timeout in ms (≤300000)")
    .option("--disk-mb <n>", "Disk in MiB (≤20480)")
    .option(
      "--network-mode <mode>",
      "public | static_egress | aws_privatelink | gcp_psc | reverse_tunnel | ssh_bastion",
    )
    .option(
      "--env-var <KEY=value>",
      "Non-sensitive literal env var (repeatable, NEVER secrets)",
      collectPair,
      [],
    )
    .option(
      "--set-default",
      "Promote this template to its environment's default",
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (opts: {
        env?: string;
        name?: string;
        slug?: string;
        description?: string;
        provider?: string;
        runtime?: string;
        vcpu?: string;
        memoryMb?: string;
        timeoutMs?: string;
        diskMb?: string;
        networkMode?: string;
        envVar?: string[];
        setDefault?: boolean;
        json?: boolean;
      }) => {
        const { handleTemplateCreate } = await import(
          "./commands/sandbox-template.js"
        );
        await handleTemplateCreate(opts);
      },
    );

  sandboxTemplate
    .command("rm <slug-or-id>")
    .description(
      "Soft-delete a sandbox template (promote another default first) — needs --yes",
    )
    .option(
      "--env <slug>",
      "Environment to disambiguate a slug (slug or env_ id)",
    )
    .option("--yes", "Confirm the deletion")
    .option("--json", "Emit raw JSON output")
    .action(
      async (
        slugOrId: string,
        opts: { env?: string; yes?: boolean; json?: boolean },
      ) => {
        const { handleTemplateRemove } = await import(
          "./commands/sandbox-template.js"
        );
        await handleTemplateRemove(slugOrId, opts);
      },
    );

  sandboxTemplate
    .command("set-default <slug-or-id>")
    .description(
      "Promote a template to its environment's default (atomic swap)",
    )
    .option(
      "--env <slug>",
      "Environment to disambiguate a slug (slug or env_ id)",
    )
    .option("--json", "Emit raw JSON output")
    .action(
      async (slugOrId: string, opts: { env?: string; json?: boolean }) => {
        const { handleTemplateSetDefault } = await import(
          "./commands/sandbox-template.js"
        );
        await handleTemplateSetDefault(slugOrId, opts);
      },
    );

  sandboxTemplate
    .command("export <slug-or-id>")
    .description(
      "Export a template as a portable v1 manifest (secret NAMES only) — stdout, or -o file",
    )
    .option(
      "--env <slug>",
      "Environment to disambiguate a slug (slug or env_ id)",
    )
    .option(
      "-o, --out <file>",
      "Write the manifest to a file instead of stdout",
    )
    .option("--json", "Emit raw JSON output (same manifest)")
    .action(
      async (
        slugOrId: string,
        opts: { env?: string; out?: string; json?: boolean },
      ) => {
        const { handleTemplateExport } = await import(
          "./commands/sandbox-template.js"
        );
        await handleTemplateExport(slugOrId, opts);
      },
    );

  sandboxTemplate
    .command("import")
    .description(
      "Import a manifest into an environment — previews first, needs --yes to write",
    )
    .requiredOption(
      "--env <slug>",
      "Environment to import into (slug or env_ id)",
    )
    .option("-f, --file <file>", "Manifest JSON file (defaults to stdin)")
    .option("--slug <slug>", "Override the manifest slug (resolve a collision)")
    .option(
      "--set-default",
      "Promote the imported template to the environment's default",
    )
    .option("--yes", "Apply the import (without it, only a preview is shown)")
    .option("--json", "Emit raw JSON output")
    .action(
      async (opts: {
        env?: string;
        file?: string;
        slug?: string;
        setDefault?: boolean;
        yes?: boolean;
        json?: boolean;
      }) => {
        const { handleTemplateImport } = await import(
          "./commands/sandbox-template.js"
        );
        await handleTemplateImport(opts);
      },
    );

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
    .description(
      "Write a starter workspace config file (default: workspace scope)",
    )
    .option(
      "--scope <scope>",
      "org | user | workspace | repo (default: workspace)",
    )
    .action(async (opts: { scope?: string }) => {
      const { configInit } = await import("./commands/config.js");
      configInit(opts.scope);
    });
  config
    .command("get")
    .description(
      "Print the merged value at a dotted path (e.g. vision.statement, commands.dev)",
    )
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
    .description(
      "Add a rule/preference/policy/convention/reference for a language",
    )
    .argument("<lang>", 'Language key, e.g. "typescript", "english"')
    .argument("<kind>", "rule | preference | policy | convention | reference")
    .argument("<text>", "Inline item text")
    .option("--scope <scope>", "user | workspace | repo (default: workspace)")
    .option("--id <id>", "Stable id (default: slugified from <text>)")
    .option("--doc <path>", "Path/URL to a doc with the full detail")
    .option("--enforced", "Surface in the agent's hard-rules section")
    .option(
      "--locked",
      "Cannot be overridden or removed by a less-authoritative scope",
    )
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
    .description(
      "Scan sources (workspace + user) and write the consolidated capability index",
    )
    .option(
      "--live-mcp",
      "Best-effort live-connect to MCP servers to list their tools (slower, network-dependent)",
    )
    .option(
      "--json",
      "Print the consolidated index as JSON instead of a summary",
    )
    .action(async (opts: { liveMcp?: boolean; json?: boolean }) => {
      const { configBuild } = await import("./commands/config.js");
      await configBuild(opts);
    });
  config
    .command("lint")
    .description(
      "Validate every scope file against the schema and report consolidated-index drift",
    )
    .action(async () => {
      const { configLint } = await import("./commands/config.js");
      await configLint();
    });
  config
    .command("doctor")
    .description(
      "Scan the config tiers (repo ▸ workspace ▸ user ▸ org managed) for problems and recommendations",
    )
    .action(async () => {
      const { configDoctor } = await import("./commands/config.js");
      await configDoctor();
    });
  config
    .command("pull")
    .description(
      "Sync user.json (and org-provisioned managed.json) from the platform",
    )
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

  // ── settings: the unified settings.json driver ──────────────────────────────

  const settings = program
    .command("settings")
    .description(
      "Inspect and edit the unified settings.json (model, env, permissions, hooks, MCP)",
    )
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
    .description(
      "List the three scope files (user / project / local) and their status",
    )
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
    .description(
      "Write a documented starter settings.json (default: project scope)",
    )
    .option("--scope <scope>", "user | project | local (default: project)")
    .action(async (opts: { scope?: string }) => {
      const { settingsInit } = await import("./commands/settings.js");
      settingsInit(opts.scope);
    });

  // ── agent: named agent definitions ──────────────────────────────────────────

  const agent = program
    .command("agent")
    .description(
      'Manage named agent definitions (run one with `oxagen --agent <name> "…"`)',
    );
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

  // ── agent env: bind agents to environments + sandbox templates ───────────────
  //
  // Server-scoped (unlike `agent list/show/new`, which manage local .oxagen/
  // agent files): the <agent> arg is an agent's public id (agt_…), slug, or
  // agent-key, resolved against the workspace's agent definitions.

  const agentEnv = agent
    .command("env")
    .description(
      "Bind an agent to an environment (and optionally a sandbox template within it)",
    );

  agentEnv
    .command("bind <agent>")
    .description(
      "Bind an agent to an environment (promotes to primary if it is the agent's first)",
    )
    .requiredOption("--env <slug>", "Environment to bind (slug or env_ id)")
    .option(
      "--template <slug>",
      "Pin a specific sandbox template (slug or sbx_ id) within the environment",
    )
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
          template?: string;
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
    .description(
      "List an agent's environment bindings with each resolved template",
    )
    .option("--json", "Emit raw JSON output")
    .action(async (agentHandle: string, opts: { json?: boolean }) => {
      const { handleAgentEnvList } = await import("./commands/agent-env.js");
      await handleAgentEnvList(agentHandle, opts);
    });

  // ── command: user-defined slash commands ────────────────────────────────────

  const command = program
    .command("command")
    .description(
      "Manage user-defined slash commands (invoke as `/name` in the REPL)",
    );
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
    .description(
      "Expand a slash command's template with args and run it as a turn",
    )
    .argument("<name>", "Command name")
    .argument("[args...]", "Arguments substituted into the template")
    .action(async (name: string, args: string[]) => {
      const { commandRun } = await import("./commands/command.js");
      await commandRun(name, args ?? []);
    });

  // ── prompt: saved prompt snippets ───────────────────────────────────────────

  const prompt = program
    .command("prompt")
    .description(
      "Manage saved prompts — reusable, describable prompt snippets you recall by name",
    );
  prompt
    .command("list")
    .description("List saved prompts")
    .action(async () => {
      const { promptList } = await import("./commands/prompt.js");
      promptList();
    });
  prompt
    .command("show")
    .description("Show a saved prompt's text")
    .argument("<name>", "Prompt name")
    .action(async (name: string) => {
      const { promptShow } = await import("./commands/prompt.js");
      promptShow(name);
    });
  prompt
    .command("new")
    .description("Scaffold a new saved prompt at .oxagen/prompts/<name>.md")
    .argument("<name>", "Prompt name")
    .action(async (name: string) => {
      const { promptNew } = await import("./commands/prompt.js");
      promptNew(name);
    });

  // ── skill: loadable skills (SKILL.md reference material) ─────────────────────

  const skill = program
    .command("skill")
    .description(
      "Manage loadable skills — SKILL.md reference material injected into the agent's system prompt",
    );
  skill
    .command("list")
    .description("List available skills")
    .action(async () => {
      const { skillList } = await import("./commands/skill.js");
      skillList();
    });
  skill
    .command("show")
    .description("Show a skill's full instructions")
    .argument("<name>", "Skill name")
    .action(async (name: string) => {
      const { skillShow } = await import("./commands/skill.js");
      skillShow(name);
    });
  skill
    .command("new")
    .description("Scaffold a new skill at .oxagen/skills/<name>/SKILL.md")
    .argument("<name>", "Skill name")
    .action(async (name: string) => {
      const { skillNew } = await import("./commands/skill.js");
      skillNew(name);
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
    .description(
      "Dry-run a proposed tool call against the guards (bash|edit|write|read)",
    )
    .argument("<tool>", "bash | edit | write | read")
    .argument(
      "<subject>",
      "The command (bash) or path (edit/write/read) to test",
    )
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
    .option(
      "-y, --yes",
      "Write the rule (default previews only — never auto-writes)",
    )
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
    .description(
      "Add an MCP server (stdio via --command, or http/sse/websocket via --url)",
    )
    .argument("<name>", "Server name (used in tool names: mcp__<name>__<tool>)")
    .option("--command <command>", "stdio: the command to spawn (e.g. npx)")
    .option(
      "--arg <arg>",
      "stdio: a command argument (repeatable)",
      collect,
      [],
    )
    .option("--url <url>", "http/sse/websocket: the server URL")
    .option(
      "--transport <transport>",
      "streamable-http | sse | websocket (default streamable-http)",
    )
    .option("--auth <auth>", "none | bearer | header (default none)")
    .option("--env-token <VAR>", "Env var holding the bearer token")
    .option(
      "--header <KEY=VALUE>",
      "Static header for header auth (repeatable)",
      collect,
      [],
    )
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
    .description(
      "Connect to a server (or all enabled) and preview the tools it exposes",
    )
    .argument("[name]", "Server name (omit to check all enabled)")
    .action(async (name: string | undefined) => {
      const { mcpCheck } = await import("./commands/mcp.js");
      await mcpCheck(name);
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
    .option(
      "--cursor <cursor>",
      "Opaque cursor from a previous page's nextCursor",
    )
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: { limit?: string; cursor?: string; json?: boolean },
      ) => {
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
    .option(
      "--capability <name>",
      "Only sample runs whose metered capability matches (e.g. chat.message.send)",
    )
    .option(
      "--since-hours <n>",
      "Lookback window over metered traces (default 168 = 7 days)",
    )
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
    .description(
      "Start an eval run against a dataset (async — poll run-status/run-get for results)",
    )
    .option(
      "--model <slug>",
      "Gateway model slug for the target (omit for the default tier)",
    )
    .option(
      "--system-prompt <text>",
      "System prompt prepended to each item's input",
    )
    .option(
      "--agent <slug>",
      "Evaluate a workspace agent instead of a bare model",
    )
    .option(
      "--judge-model <slug>",
      "Gateway model slug for the judge (omit for the precise tier)",
    )
    .option("--name <text>", "Optional label for the run")
    .option(
      "--pass-threshold <n>",
      "Overall judge score (0-1) at/above which an item passes (default 0.7)",
    )
    .option(
      "--max-items <n>",
      "Cap items evaluated this run (cost control); omit for all items",
    )
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
          passThreshold: opts.passThreshold
            ? Number(opts.passThreshold)
            : undefined,
          maxItems: opts.maxItems ? Number(opts.maxItems) : undefined,
          json: opts.json,
        });
      },
    );
  evalCmd
    .command("run-status <runId>")
    .description(
      "Poll an eval run's lifecycle: status, progress counts, and mean score",
    )
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
  evalCmd
    .command("runs-list")
    .description(
      "List eval runs with date/status/model filters, sorting, and pagination",
    )
    .option("--dataset <id>", "Restrict to one dataset (its public id)")
    .option("--since <iso>", "Only runs created at/after this ISO datetime")
    .option("--until <iso>", "Only runs created at/before this ISO datetime")
    .option(
      "--status <state>",
      "pending|queued|running|completed|failed|cancelled",
    )
    .option("--model <slug>", "Only runs whose target model matches exactly")
    .option("--sort <key>", "score|created|model|status (default created)")
    .option("--dir <dir>", "asc|desc (default desc)")
    .option("--limit <n>", "Page size (1-100, default 25)")
    .option("--offset <n>", "Page offset (default 0)")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        dataset?: string;
        since?: string;
        until?: string;
        status?: string;
        model?: string;
        sort?: string;
        dir?: string;
        limit?: string;
        offset?: string;
        json?: boolean;
      }) => {
        const { evalRunsList } = await import("./commands/eval.js");
        await evalRunsList({
          dataset: opts.dataset,
          since: opts.since,
          until: opts.until,
          status: opts.status,
          model: opts.model,
          sort: opts.sort,
          dir: opts.dir,
          limit: opts.limit ? Number(opts.limit) : undefined,
          offset: opts.offset ? Number(opts.offset) : undefined,
          json: opts.json,
        });
      },
    );
  evalCmd
    .command("runs-series")
    .description(
      "Bucketed score-over-time series plus a per-model breakdown for charts",
    )
    .option("--dataset <id>", "Restrict to one dataset (its public id)")
    .option("--since <iso>", "Only runs created at/after this ISO datetime")
    .option("--until <iso>", "Only runs created at/before this ISO datetime")
    .option("--bucket <unit>", "day|week (default day)")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        dataset?: string;
        since?: string;
        until?: string;
        bucket?: string;
        json?: boolean;
      }) => {
        const { evalRunsSeries } = await import("./commands/eval.js");
        await evalRunsSeries({
          dataset: opts.dataset,
          since: opts.since,
          until: opts.until,
          bucket: opts.bucket,
          json: opts.json,
        });
      },
    );

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

  // ── fleet: the session fleet (ADR-023) ──────────────────────────────────────

  // Shared output flags live ONLY on this parent: Commander's non-positional
  // parsing lets the parent claim `--json`/`--quiet` wherever they appear in a
  // `fleet …` invocation (even after the subcommand), so re-declaring them on
  // subcommands would shadow the parsed value with a default-false copy — the
  // parent wins the parse, the child's default wins the read, and the flag is
  // silently lost. Every fleet action therefore reads
  // `command.optsWithGlobals()` (the `pr fix`/`cost` pattern), which also
  // surfaces the program-wide `--verbose`. Subcommands declare only their OWN
  // flags, which no ancestor duplicates.
  const fleet = program
    .command("fleet")
    .description(
      "Mission Control for many agent sessions (piped: streams the fleet as NDJSON). " +
        "--json and --quiet here apply to every fleet subcommand.",
    )
    .option(
      "--json",
      "Machine output for any fleet subcommand (NDJSON for streams)",
      false,
    )
    .option(
      "--quiet",
      "Suppress progress chrome (stderr); data still emits",
      false,
    )
    .action(async (_opts: unknown, command: Command) => {
      const { handleFleetRoot } = await import("./commands/fleet.js");
      await handleFleetRoot(command.optsWithGlobals());
    });

  fleet
    .command("dispatch")
    .description("Start a detached session, print its sid, exit")
    .argument(
      "[prompt...]",
      'The task ("-" or empty with piped stdin reads the prompt from stdin)',
    )
    .option("-m, --model <slug>", "Gateway model slug for the session")
    .option("--agent <name>", "Run the session as a named agent definition")
    .option(
      "--once",
      "End after the first turn (default: a conversation session)",
      false,
    )
    .option(
      "--follow",
      "Stream the session's events to completion; exit code is its fate",
      false,
    )
    .action(async (promptWords: string[], _opts: unknown, command: Command) => {
      // The worker this spawns runs the engine — gate on an account (BYOK
      // auto-applies), exactly like the root one-shot action.
      const { requireSession } = await import("./lib/session.js");
      requireSession();
      const { handleFleetDispatch } = await import("./commands/fleet.js");
      await handleFleetDispatch(promptWords, command.optsWithGlobals());
    });

  fleet
    .command("ls")
    .description("List sessions from their meta.json snapshots")
    .action(async (_opts: unknown, command: Command) => {
      const { handleFleetLs } = await import("./commands/fleet.js");
      await handleFleetLs(command.optsWithGlobals());
    });

  fleet
    .command("watch")
    .description("Merged live stream; no sids means all non-terminal sessions")
    .argument("[sids...]", "Sessions to watch; omit for all active sessions")
    .action(async (sids: string[], _opts: unknown, command: Command) => {
      const { handleFleetWatch } = await import("./commands/fleet.js");
      await handleFleetWatch(sids, command.optsWithGlobals());
    });

  fleet
    .command("attach")
    .description(
      "Mission Control focused on one session (TTY), or its NDJSON from the start plus live follow",
    )
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .action(async (sid: string, _opts: unknown, command: Command) => {
      const { handleFleetAttach } = await import("./commands/fleet.js");
      await handleFleetAttach(sid, command.optsWithGlobals());
    });

  fleet
    .command("send")
    .description("Append a follow-up message to a session's inbox")
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .argument("<message...>", 'The follow-up turn ("-" reads from stdin)')
    .action(
      async (
        sid: string,
        messageWords: string[],
        _opts: unknown,
        command: Command,
      ) => {
        const { handleFleetSend } = await import("./commands/fleet.js");
        await handleFleetSend(sid, messageWords, command.optsWithGlobals());
      },
    );

  fleet
    .command("cancel")
    .description("Cancel a session, or all of them")
    .argument("[sid]", "Session id to cancel; omit with --all")
    .option("--all", "Cancel every non-terminal session", false)
    .action(
      async (sid: string | undefined, _opts: unknown, command: Command) => {
        const { handleFleetCancel } = await import("./commands/fleet.js");
        await handleFleetCancel(sid, command.optsWithGlobals());
      },
    );

  fleet
    .command("logs")
    .description("Dump a session's raw events.ndjson")
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .option("--from-seq <n>", "Resume the replay at this sequence number")
    .option("--follow", "Keep tailing after the replay", false)
    .action(async (sid: string, _opts: unknown, command: Command) => {
      const { handleFleetLogs } = await import("./commands/fleet.js");
      await handleFleetLogs(sid, command.optsWithGlobals());
    });

  fleet
    .command("clean")
    .description("Prune terminal sessions")
    .option(
      "--older-than <age>",
      "Age cutoff: days (7) or a duration (1d, 12h) — default 7",
      "7",
    )
    .option("--all", "Prune every terminal session regardless of age", false)
    .action(async (_opts: unknown, command: Command) => {
      const { handleFleetClean } = await import("./commands/fleet.js");
      await handleFleetClean(command.optsWithGlobals());
    });

  fleet
    .command("replay")
    .description(
      "Time-travel view of a recorded session (ADR-028): per-turn prompts, tool calls, diffs, usage",
    )
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .option("--turn <n>", "Show this turn's FULL tool input/output payloads")
    .option(
      "--verify",
      "Check record integrity (refs resolve + hash clean); exit 1 on failure",
      false,
    )
    .action(async (sid: string, _opts: unknown, command: Command) => {
      const { handleFleetReplay } = await import("./commands/fleet.js");
      await handleFleetReplay(sid, command.optsWithGlobals());
    });

  fleet
    .command("bisect")
    .description(
      "Binary-search the first bad turn of a recorded session by restoring the tree " +
        "at each probed turn and running --cmd there (exit 0 = good). Assumes monotonic " +
        "badness — once a turn dooms the run, later turns stay bad (like git bisect).",
    )
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .requiredOption(
      "--cmd <shell>",
      "Predicate run via sh -c in the restored tree",
    )
    .option("--good <n>", "Known-good turn (default 0 = session start)")
    .option("--bad <n>", "Known-bad turn (default: the last settled turn)")
    .action(async (sid: string, _opts: unknown, command: Command) => {
      const { handleFleetBisect } = await import("./commands/fleet.js");
      await handleFleetBisect(sid, command.optsWithGlobals());
    });

  fleet
    .command("resume")
    .description(
      "Fork a recorded session from the state after --turn N: restored scratch worktree + " +
        "reconstructed history, dispatched as a new detached session",
    )
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .requiredOption(
      "--turn <n>",
      "Fork point: resume from the state AFTER this turn (0 = start)",
    )
    .option(
      "-m, --model <slug>",
      "Model for the fork (default: the source run's)",
    )
    .option(
      "-p, --prompt <text>",
      "Prompt for the fork (default: the source's next-turn prompt)",
    )
    .action(async (sid: string, _opts: unknown, command: Command) => {
      // The fork spawns a detached worker running the engine — gate like dispatch.
      const { requireSession } = await import("./lib/session.js");
      requireSession();
      const { handleFleetResume } = await import("./commands/fleet.js");
      await handleFleetResume(sid, command.optsWithGlobals());
    });

  fleet
    .command("feedback")
    .description(
      "Record a human verdict on a finished session (thumbs-down auto-distills it to an eval item)",
    )
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .argument("<verdict>", '"up" or "down"')
    .option(
      "-m, --message <comment>",
      "Optional comment attached to the verdict",
    )
    .action(
      async (
        sid: string,
        verdict: string,
        _opts: unknown,
        command: Command,
      ) => {
        const merged = command.optsWithGlobals<{
          message?: string;
          model?: unknown;
        }>();
        // The root program's global `-m, --model` claims `-m` before this
        // subcommand can (commander parses ancestor options non-positionally —
        // the same gotcha the fleet parent documents for --json). Feedback has
        // no model semantics, so a swallowed `-m` value was meant as the
        // message; `--message` always wins when both are present.
        if (merged.message === undefined && typeof merged.model === "string") {
          merged.message = merged.model;
        }
        const { handleFleetFeedback } = await import("./commands/fleet.js");
        await handleFleetFeedback(sid, verdict, merged);
      },
    );

  fleet
    .command("distill")
    .description(
      "Distill a recorded session into an evals-v1 dataset item (local record/distilled.json; " +
        "--push adds it to the platform dataset)",
    )
    .argument("<sid>", "Session id (full, short tail, or unique prefix)")
    .option(
      "--push",
      "Push the item to the platform via the eval.* capabilities",
      false,
    )
    .option(
      "--dataset <slug>",
      "Target dataset slug (default: fleet-distilled-failures, created on demand)",
    )
    .action(async (sid: string, _opts: unknown, command: Command) => {
      const { handleFleetDistill } = await import("./commands/fleet.js");
      await handleFleetDistill(sid, command.optsWithGlobals());
    });

  fleet
    .command("worker <sid>", { hidden: true })
    .description(
      "[internal] Run a detached session worker (spawned by dispatch)",
    )
    .action(async (sid: string) => {
      // The worker is what actually needs credentials — gate it like dispatch.
      const { requireSession } = await import("./lib/session.js");
      requireSession();
      const { handleFleetWorker } = await import("./commands/fleet.js");
      const { code } = await handleFleetWorker(sid);
      process.exit(code);
    });

  return program;
}
