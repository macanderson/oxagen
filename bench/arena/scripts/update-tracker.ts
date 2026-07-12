#!/usr/bin/env tsx
/**
 * Arena Tracker Update
 *
 * Updates progress tracking history with latest benchmark results.
 * Maintains longitudinal data for observing agent improvement over time.
 *
 * Usage:
 *   tsx scripts/update-tracker.ts [options]
 *
 * Options:
 *   --input <dir>      Input results directory [default: results/]
 *   --output <file>    Output history file [default: tracker/history.json]
 *   --append           Append to existing history (default: replace)
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync
} from "fs";
import { join } from "path";
import { parseArgs } from "util";

import type { TrackerEntry, BenchmarkResult, AgentType } from "../src/lib/types.js";

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    input: { type: "string" },
    output: { type: "string" },
    append: { type: "boolean", default: false }
  }
});

const values = args.values as {
  input?: string;
  output?: string;
  append?: boolean;
};

const inputDir = values.input ?? "results/";
const outputFile = values.output ?? "tracker/history.json";
const append = values.append ?? false;

console.log("📊 Arena Tracker Update");
console.log("=".repeat(50));

// Load existing history
let history: TrackerEntry[] = [];

if (append && existsSync(outputFile)) {
  try {
    history = JSON.parse(readFileSync(outputFile, "utf-8")) as TrackerEntry[];
    console.log(`\n📂 Loaded ${history.length} existing entries`);
  } catch (error) {
    console.warn(`  ⚠️  Failed to load history: ${String(error)}`);
  }
}

// Collect results
console.log(`\n🔍 Scanning ${inputDir} for results...`);

const results: BenchmarkResult[] = [];

function scanDirectory(dir: string): void {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(path);
    } else if (entry.name.endsWith(".json") && entry.name !== "summary.json") {
      try {
        const content = readFileSync(path, "utf-8");
        const result = JSON.parse(content) as BenchmarkResult;
        results.push(result);
      } catch (error) {
        console.warn(`  ⚠️  Failed to parse ${path}: ${String(error)}`);
      }
    }
  }
}

scanDirectory(inputDir);

console.log(`  Found ${results.length} results`);

if (results.length === 0) {
  console.error("❌ No results found");
  process.exit(1);
}

// Group by agent and model
const agentGroups = new Map<string, BenchmarkResult[]>();

for (const result of results) {
  const key = `${result.agent.type}:${result.agent.model}`;
  let group = agentGroups.get(key);
  if (!group) {
    group = [];
    agentGroups.set(key, group);
  }
  group.push(result);
}

// Calculate metrics for each agent
const today = new Date().toISOString().split("T")[0];
const newEntries: TrackerEntry[] = [];

for (const [key, agentResults] of agentGroups) {
  const [agentType, model] = key.split(":") as [AgentType, string];

  const successCount = agentResults.filter(r => r.metrics.success).length;
  const successRate = successCount / agentResults.length;
  const avgCost = agentResults.reduce((sum, r) => sum + r.metrics.totalCost, 0) / agentResults.length;
  const avgDuration = agentResults.reduce((sum, r) => sum + r.metrics.durationSeconds, 0) / agentResults.length;

  // Calculate change from previous entry
  const prevEntry = history
    .filter(e => e.agentType === agentType && e.model === model)
    .sort((a, b) => b.date.localeCompare(a.date))
    .at(0);

  let notes: string | undefined;

  if (prevEntry) {
    const rateChange = (successRate - prevEntry.successRate) * 100;
    const costChange = avgCost - prevEntry.avgCost;

    if (Math.abs(rateChange) > 5) {
      notes = `Success rate ${rateChange > 0 ? "improved" : "declined"} by ${Math.abs(rateChange).toFixed(1)}%`;
    } else if (Math.abs(costChange) > 0.05) {
      notes = `Cost ${costChange > 0 ? "increased" : "decreased"} by $${Math.abs(costChange).toFixed(2)}`;
    }
  }

  newEntries.push({
    date: today,
    agentType,
    model,
    successRate,
    avgCost,
    avgDuration,
    tasksCompleted: agentResults.length,
    notes
  });
}

// Merge with existing history
const updatedHistory = append
  ? [...history.filter(e => e.date !== today), ...newEntries]
  : newEntries;

// Sort by date (newest first)
updatedHistory.sort((a, b) => b.date.localeCompare(a.date));

// Ensure output directory exists
const outputDir = outputFile.substring(0, outputFile.lastIndexOf("/"));
mkdirSync(outputDir, { recursive: true });

// Write history
writeFileSync(outputFile, JSON.stringify(updatedHistory, null, 2));

console.log(`\n✅ History updated: ${outputFile}`);
console.log(`   Total entries: ${updatedHistory.length}`);
console.log(`   New entries: ${newEntries.length}`);

// Print summary
console.log("\n📈 Latest Entry Summary:");
for (const entry of newEntries) {
  console.log(`\n  ${entry.agentType} (${entry.model})`);
  console.log(`    Success Rate:   ${(entry.successRate * 100).toFixed(1)}%`);
  console.log(`    Avg Cost:      $${entry.avgCost.toFixed(2)}`);
  console.log(`    Avg Duration:  ${entry.avgDuration.toFixed(1)}s`);
  console.log(`    Tasks:          ${entry.tasksCompleted}`);
  if (entry.notes) {
    console.log(`    📌 ${entry.notes}`);
  }
}

console.log();
