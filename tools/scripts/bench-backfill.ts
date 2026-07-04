#!/usr/bin/env tsx
/**
 * One-off backfill: ingest the 2026-07-03 best-of-N swe-bench runs into the
 * bench.* ClickHouse tables (packages/telemetry/src/migrations/0018_bench_schema.sql).
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
 *   tsx tools/scripts/bench-backfill.ts             # skip runs already ingested
 *   tsx tools/scripts/bench-backfill.ts --force      # re-ingest even if already present
 */
import { existsSync } from "node:fs";
import { closeClickhouse, ingestBenchResultsDir, type IngestBenchOptions, type BenchReplayConfig } from "@oxagen/telemetry";

const out = (s: string): void => void process.stdout.write(s + "\n");

// Shared across both runs — both used the same best-of-N recipe (3
// candidates, full pipeline + verify-auto, xhigh effort, 2 revise rounds).
const SHARED_CONFIG: BenchReplayConfig = {
  OXAGEN_BEST_OF_N: "1",
  OXAGEN_BEST_OF_N_MODELS: "anthropic/claude-fable-5,anthropic/claude-fable-5,openai/gpt-5.5-pro",
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
const CONDITIONS = { os: "darwin", cpu: "arm64", docker_vm: "VZ", rosetta: "default" };

interface BackfillEntry {
  dir: string;
  gitSha: string;
  costUsd: number;
  status: "completed" | "partial";
  notes: string;
}

const ENTRIES: BackfillEntry[] = [
  {
    dir: "/Users/macanderson/Workspaces/oxagen-bestofn-bench/bench/swe-bench/results-oxagen/2026-07-03__14-26-32",
    gitSha: "3e41c91e",
    costUsd: 12,
    status: "completed",
    notes: "2026-07-03 backfill: single-task smoke run (django__django-11099)",
  },
  {
    dir: "/Users/macanderson/Workspaces/oxagen-benchrun/bench/swe-bench/results-oxagen/2026-07-03__14-59-00",
    gitSha: "0b9d2317",
    costUsd: 53,
    status: "partial",
    notes:
      "2026-07-03 backfill: 4-task run (11099, 11095, 13401, 11133) — " +
      "django__django-11133 never finished (credit wall mid-run)",
  },
];

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  out(`bench-backfill: ${ENTRIES.length} run(s) to ingest${force ? " (--force)" : ""}\n`);

  for (const entry of ENTRIES) {
    if (!existsSync(entry.dir)) {
      out(`skip (results dir no longer exists): ${entry.dir}`);
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

    out(`ingesting ${entry.dir}`);
    const summary = await ingestBenchResultsDir(entry.dir, options);

    if (summary.alreadyIngested) {
      out(`  already ingested as run #${summary.runPublicId} — skipping (pass --force to re-ingest)\n`);
      continue;
    }

    out(`  run #${summary.runPublicId} — ${summary.nTasks} task(s), ${summary.nResolved} resolved`);
    for (const r of summary.results) {
      out(`    #${r.publicId}  ${r.taskId}  reward=${r.reward}  resolved=${r.resolved}`);
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
    process.stderr.write(`bench-backfill failed: ${err instanceof Error ? err.message : String(err)}\n`);
    await closeClickhouse();
    process.exitCode = 1;
  });
