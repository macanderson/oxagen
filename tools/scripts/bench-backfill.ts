#!/usr/bin/env tsx
/**
 * One-off backfill: ingest the 2026-07-03 best-of-N swe-bench runs into the
 * bench.* ClickHouse tables (packages/bench/migrations/0001_bench_schema.sql).
 * @oxagen/bench is a private, never-published package — this backfill is
 * exactly the kind of internal-only consumer it exists for.
 *
 * Both runs predate the bench-config.json snapshot that
 * bench/swe-bench/run.sh now writes automatically (see that script), so the
 * replay config / git sha / cost are supplied explicitly here rather than
 * read from a snapshot file — reconstructed from the actual run recipe (see
 * bench/terminal-bench/run.sh's "Full differentiated config" section, which
 * both runs used the swe-bench equivalent of).
 *
 * Targets whatever CLICKHOUSE_* is active in the environment — run once
 * against local (.env.local pointed at localhost:8123) to validate, then
 * again against prod. ALWAYS confirm the target host before running against
 * prod (see the CLICKHOUSE_URL echo in the operating instructions this
 * script was written for).
 *
 * Usage:
 *   tsx tools/scripts/bench-backfill.ts                          # skip runs already ingested
 *   tsx tools/scripts/bench-backfill.ts --force                  # re-ingest even if already present
 *   tsx tools/scripts/bench-backfill.ts --results-root <dir>     # base dir holding the run dirs
 *   tsx tools/scripts/bench-backfill.ts <dir> [<dir>...]         # explicit run dirs (matched to
 *                                                                # entries by basename)
 *
 * Run directories are resolved, in order of precedence:
 *   1. Positional CLI args (absolute or relative paths to run dirs).
 *   2. `--results-root <dir>` flag or BENCH_RESULTS_ROOT env var — each
 *      entry's run id is resolved as `<results-root>/<run-id>`.
 *   3. Default: `bench/swe-bench/results-oxagen` relative to the repo root.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeClickhouse } from "@oxagen/telemetry";
import {
  ingestBenchResultsDir,
  type IngestBenchOptions,
  type BenchReplayConfig,
} from "@oxagen/bench";

const out = (s: string): void => void process.stdout.write(s + "\n");

// Shared across both runs — both used the same best-of-N recipe (3
// candidates, full pipeline + verify-auto, xhigh effort, 2 revise rounds).
const SHARED_CONFIG: BenchReplayConfig = {
  OXAGEN_BEST_OF_N: "1",
  OXAGEN_BEST_OF_N_MODELS:
    "anthropic/claude-fable-5,anthropic/claude-fable-5,openai/gpt-5.5-pro",
  OXAGEN_BEST_OF_N_CANDIDATES: "3",
  OXAGEN_BEST_OF_N_PIPELINE: "1",
  OXAGEN_BEST_OF_N_VERIFY: "1",
  OXAGEN_LLM_EVALUATOR: "anthropic/claude-sonnet-5",
  OXAGEN_LLM_ADVISOR: "openai/gpt-5.5-pro",
  OXAGEN_EFFORT: "xhigh",
  OXAGEN_MAX_REVISE_ROUNDS: "2",
  DATASET: "swe-bench/swe-bench-verified",
};

// Host conditions for both runs — same machine, same session.
const CONDITIONS = {
  os: "darwin",
  cpu: "arm64",
  docker_vm: "VZ",
  rosetta: "default",
};

interface BackfillEntry {
  /** Run id — the basename of the results dir (e.g. "2026-07-03__14-26-32"). */
  runId: string;
  gitSha: string;
  costUsd: number;
  status: "completed" | "partial";
  notes: string;
}

const ENTRIES: BackfillEntry[] = [
  {
    runId: "2026-07-03__14-26-32",
    gitSha: "3e41c91e",
    costUsd: 12,
    status: "completed",
    notes: "2026-07-03 backfill: single-task smoke run (django__django-11099)",
  },
  {
    runId: "2026-07-03__14-59-00",
    gitSha: "0b9d2317",
    costUsd: 53,
    status: "partial",
    notes:
      "2026-07-03 backfill: 4-task run (11099, 11095, 13401, 11133) — " +
      "django__django-11133 never finished (credit wall mid-run)",
  },
];

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const DEFAULT_RESULTS_ROOT = resolve(
  REPO_ROOT,
  "bench/swe-bench/results-oxagen",
);

/** Parse CLI args into { force, resultsRoot, positionalDirs }. */
function parseArgs(argv: string[]): {
  force: boolean;
  resultsRoot: string;
  positionalDirs: string[];
} {
  const force = argv.includes("--force");
  const positionalDirs: string[] = [];
  let resultsRoot = process.env.BENCH_RESULTS_ROOT ?? DEFAULT_RESULTS_ROOT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--force") continue;
    if (arg === "--results-root") {
      const value = argv[++i];
      if (!value)
        throw new Error("--results-root requires a directory argument");
      resultsRoot = value;
      continue;
    }
    if (arg.startsWith("--results-root=")) {
      resultsRoot = arg.slice("--results-root=".length);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    positionalDirs.push(arg);
  }

  return { force, resultsRoot: resolve(resultsRoot), positionalDirs };
}

/**
 * Resolve each entry to a concrete results dir. Explicit positional dirs win
 * (matched to entries by basename); anything not given explicitly falls back
 * to `<results-root>/<run-id>`.
 */
function resolveEntryDirs(
  resultsRoot: string,
  positionalDirs: string[],
): { entry: BackfillEntry; dir: string }[] {
  const byRunId = new Map<string, string>();
  for (const dir of positionalDirs) {
    byRunId.set(basename(resolve(dir)), resolve(dir));
  }
  return ENTRIES.map((entry) => ({
    entry,
    dir: byRunId.get(entry.runId) ?? resolve(resultsRoot, entry.runId),
  }));
}

async function main(): Promise<void> {
  const { force, resultsRoot, positionalDirs } = parseArgs(
    process.argv.slice(2),
  );
  const resolved = resolveEntryDirs(resultsRoot, positionalDirs);
  out(
    `bench-backfill: ${resolved.length} run(s) to ingest${force ? " (--force)" : ""}\n`,
  );

  for (const { entry, dir } of resolved) {
    if (!existsSync(dir)) {
      out(`skip (results dir does not exist): ${dir}`);
      continue;
    }

    const options: IngestBenchOptions = {
      benchType: "swe-bench",
      gitSha: entry.gitSha,
      config: SHARED_CONFIG,
      conditions: CONDITIONS,
      costUsd: entry.costUsd,
      status: entry.status,
      notes: entry.notes,
      force,
    };

    out(`ingesting ${dir}`);
    const summary = await ingestBenchResultsDir(dir, options);

    if (summary.alreadyIngested) {
      out(
        `  already ingested as run #${summary.runPublicId} — skipping (pass --force to re-ingest)\n`,
      );
      continue;
    }

    out(
      `  run #${summary.runPublicId} — ${summary.nTasks} task(s), ${summary.nResolved} resolved`,
    );
    for (const r of summary.results) {
      out(
        `    #${r.publicId}  ${r.taskId}  reward=${r.reward}  resolved=${r.resolved}`,
      );
    }
    for (const s of summary.skipped) {
      out(`    skipped ${s.taskId}: ${s.reason}`);
    }
    out("");
  }

  out("bench-backfill: done.");
}

main()
  .then(() => closeClickhouse())
  .catch(async (err: unknown) => {
    process.stderr.write(
      `bench-backfill failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await closeClickhouse();
    process.exitCode = 1;
  });
