#!/usr/bin/env tsx
/**
 * Arena Benchmark Runner
 *
 * Executes benchmark tasks against configured agents and collects results.
 *
 * Usage:
 *   tsx scripts/run-benchmark.ts [options]
 *
 * Options:
 *   --agent <type>        Agent type (oxagen, stella, claude-code) [default: oxagen]
 *   --model <slug>        Model identifier [default: anthropic/claude-sonnet-5]
 *   --task <id>           Task ID to run (repeat for multiple) [default: smoke tests]
 *   --budget <usd>        Budget limit in USD [default: 25]
 *   --timeout <seconds>   Timeout per task [default: 600]
 *   --concurrent <n>      Number of concurrent tasks [default: 1]
 *   --output <dir>        Results directory [default: results/]
 *   --filter <criteria>   Filter tasks by category/difficulty/ecosystem
 *   --list                List available tasks and exit
 *   --dry-run             Show what would be run without executing
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

import {
  allTasks,
  getTasksByCategory,
  getTasksByDifficulty,
  getTasksByEcosystem,
  SMOKE_TASK_IDS,
} from "../tasks/index.js";
import { getRunner } from "../runners/index.js";
import { scrubProcessEnv } from "../src/lib/env.js";
import type { AgentType, BenchmarkResult } from "../src/lib/types.js";

// Drop pnpm-injected env keys npm rejects before spawning any agent CLI, so
// runner child processes don't inherit them and emit `npm warn Unknown env
// config …`. (The web orchestrator sanitizes at its own spawn; this covers the
// direct-CLI path, where this script is the parent of the agent processes.)
scrubProcessEnv();

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string" },
    model: { type: "string" },
    task: { type: "string", multiple: true },
    budget: { type: "string" },
    timeout: { type: "string" },
    concurrent: { type: "string" },
    output: { type: "string" },
    filter: { type: "string" },
    list: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const values = args.values as {
  agent?: string;
  model?: string;
  task?: string[];
  budget?: string;
  timeout?: string;
  concurrent?: string;
  output?: string;
  filter?: string;
  list?: boolean;
  "dry-run"?: boolean;
};

// List available tasks
if (values.list) {
  console.log("\n📋 Available Arena Tasks:\n");
  for (const [id, task] of Object.entries(allTasks)) {
    console.log(`  ${id}`);
    console.log(`    ${task.name}`);
    console.log(
      `    Category: ${task.category} | Difficulty: ${task.difficulty} | Ecosystem: ${task.ecosystem}`,
    );
    console.log(
      `    Est. tokens: ${task.estimatedTokens.toLocaleString()} | Est. cost: $${task.estimatedCost.toFixed(2)}`,
    );
    console.log();
  }
  process.exit(0);
}

// Parse configuration
const agentType = (values.agent ?? "oxagen") as AgentType;
const model = values.model ?? "anthropic/claude-sonnet-5";
const budget = values.budget ? parseFloat(values.budget) : 25;
const timeout = values.timeout ? parseInt(values.timeout, 10) : 600;
// NB: `--concurrent` is parsed and advertised but not yet wired into the
// runner; drop the unused local until concurrency lands (the flag stays).
const outputDir = values.output ?? "results";
const dryRun = values["dry-run"] ?? false;

// Select tasks
let taskIds = values.task;
if (!taskIds || taskIds.length === 0) {
  taskIds = SMOKE_TASK_IDS;
}

// Apply filters
if (values.filter) {
  const [key, value] = values.filter.split("=");
  let filteredTasks: string[] = [];

  switch (key) {
    case "category":
      filteredTasks = getTasksByCategory(value).map((t) => t.id);
      break;
    case "difficulty":
      filteredTasks = getTasksByDifficulty(value).map((t) => t.id);
      break;
    case "ecosystem":
      filteredTasks = getTasksByEcosystem(value).map((t) => t.id);
      break;
  }

  // `taskIds` is always a populated array by this point (defaulted to the
  // smoke set above), so intersect it with the filter result directly.
  taskIds = taskIds.filter((id) => filteredTasks.includes(id));
}

const tasks = taskIds.map((id) => allTasks[id]).filter(Boolean);

if (tasks.length === 0) {
  console.error("❌ No tasks found matching the criteria");
  process.exit(1);
}

// Show run plan
console.log("\n🎯 Arena Benchmark Run Plan");
console.log("=".repeat(50));
console.log(`Agent:     ${agentType}`);
console.log(`Model:     ${model}`);
console.log(`Budget:    $${budget}`);
console.log(`Timeout:   ${timeout}s per task`);
console.log(`Tasks:     ${tasks.length}`);
console.log();

let totalEstTokens = 0;
let totalEstCost = 0;

for (const task of tasks) {
  console.log(`  • ${task.id}`);
  console.log(`    ${task.name}`);
  console.log(
    `    Est: ${task.estimatedTokens.toLocaleString()} tokens / $${task.estimatedCost.toFixed(2)}`,
  );
  totalEstTokens += task.estimatedTokens;
  totalEstCost += task.estimatedCost;
}

console.log();
console.log(
  `Total est: ${totalEstTokens.toLocaleString()} tokens / $${totalEstCost.toFixed(2)}`,
);
console.log();

if (dryRun) {
  console.log("🔍 Dry run — exiting without execution");
  process.exit(0);
}

// Check agent availability
console.log("🔍 Checking agent availability...");
const runner = getRunner(agentType);
const available = await runner.isAvailable();

if (!available) {
  console.error(`❌ Agent ${agentType} is not available`);
  console.error(`   Ensure it's installed and in your PATH`);
  process.exit(1);
}

const version = await runner.getVersion();
console.log(`✅ ${agentType} version: ${version}`);
console.log();

// Create output directory
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
const runDir = join(outputDir, `${agentType}-${timestamp}`);
mkdirSync(runDir, { recursive: true });

// Run benchmarks
console.log("🚀 Starting benchmark execution...");
console.log();

const results: BenchmarkResult[] = [];

for (const task of tasks) {
  console.log(`\n▶️  Running: ${task.id} — ${task.name}`);

  try {
    const result = await runner.runTask(task, {
      type: agentType,
      model,
      budget,
      timeout,
    });

    results.push(result);

    // Write individual result. The id embeds the model, which may contain a
    // "/" (e.g. "anthropic/claude-opus-4.8"); sanitize it to a flat filename
    // so the write doesn't target a non-existent nested directory and fail.
    const safeId = result.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const resultFile = join(runDir, `${safeId}.json`);
    writeFileSync(resultFile, JSON.stringify(result, null, 2));

    const status = result.metrics.success ? "✅" : "❌";
    const duration = result.metrics.durationSeconds.toFixed(1);
    const cost = result.metrics.totalCost.toFixed(2);
    const tokens = result.metrics.totalTokens.toLocaleString();

    console.log(`   ${status} ${duration}s | $${cost} | ${tokens} tokens`);

    if (result.error) {
      console.log(`   ⚠️  Error: ${result.error}`);
    }
  } catch (error) {
    console.error(`   ❌ Failed: ${String(error)}`);
  }
}

// Write summary
const summary = {
  metadata: {
    agentType,
    model,
    budget,
    timeout,
    runDate: new Date().toISOString(),
    tasksCompleted: results.length,
    tasksTotal: tasks.length,
  },
  results,
  summary: {
    totalTasks: results.length,
    successful: results.filter((r) => r.metrics.success).length,
    failed: results.filter((r) => !r.metrics.success).length,
    totalDuration: results.reduce(
      (sum, r) => sum + r.metrics.durationSeconds,
      0,
    ),
    totalCost: results.reduce((sum, r) => sum + r.metrics.totalCost, 0),
    totalTokens: results.reduce((sum, r) => sum + r.metrics.totalTokens, 0),
  },
};

const summaryFile = join(runDir, "summary.json");
writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

// Print final summary
console.log("\n" + "=".repeat(50));
console.log("📊 Benchmark Run Summary");
console.log("=".repeat(50));
console.log(
  `Completed:     ${summary.summary.successful}/${summary.summary.totalTasks}`,
);
console.log(
  `Success rate:  ${((summary.summary.successful / summary.summary.totalTasks) * 100).toFixed(1)}%`,
);
console.log(`Total time:    ${summary.summary.totalDuration.toFixed(1)}s`);
console.log(`Total cost:    $${summary.summary.totalCost.toFixed(2)}`);
console.log(`Total tokens:  ${summary.summary.totalTokens.toLocaleString()}`);
console.log();
console.log(`Results: ${runDir}`);
console.log();
