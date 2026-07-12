#!/usr/bin/env tsx
/**
 * Arena Report Generator
 *
 * Generates comprehensive benchmark reports from collected results.
 *
 * Usage:
 *   tsx scripts/generate-report.ts [options]
 *
 * Options:
 *   --input <dir>         Input results directory [default: results/]
 *   --output <file>       Output report file [default: reports/benchmark-report.html]
 *   --format <type>       Report format (html, markdown, json) [default: html]
 *   --compare             Generate comparison report across agents
 *   --history             Include progress tracking history
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { parseArgs } from "util";
import type {
  BenchmarkResult,
  BenchmarkReport,
  TaskAgentSummary,
  TrackerEntry,
} from "../src/lib/types.js";

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    input: { type: "string" },
    output: { type: "string" },
    format: { type: "string" },
    compare: { type: "boolean", default: false },
    history: { type: "boolean", default: false },
  },
});

const values = args.values as {
  input?: string;
  output?: string;
  format?: string;
  compare?: boolean;
  history?: boolean;
};

const inputDir = values.input ?? "results/";
const outputFile = values.output ?? "reports/benchmark-report.html";
const format = values.format ?? "html";
const compare = values.compare ?? false;
const includeHistory = values.history ?? false;

console.log("📊 Arena Report Generator");
console.log("=".repeat(50));

// Collect all results
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
        console.warn(`  ⚠️  Failed to parse ${path}: ${error}`);
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

// Group by task + agent
const summaries = new Map<string, TaskAgentSummary>();

for (const result of results) {
  const key = `${result.taskId}:${result.agent.type}:${result.agent.model}`;

  if (!summaries.has(key)) {
    summaries.set(key, {
      taskId: result.taskId,
      agentType: result.agent.type,
      model: result.agent.model,
      runCount: 0,
      successRate: 0,
      avgDuration: 0,
      avgCost: 0,
      avgTokens: 0,
      latestRun:
        result.provenance.kind === "measured" ? result.provenance.runDate : "",
    });
  }

  const summary = summaries.get(key)!;
  summary.runCount++;

  // Update averages
  const prevSuccessRate = summary.successRate;
  const prevAvgDuration = summary.avgDuration;
  const prevAvgCost = summary.avgCost;
  const prevAvgTokens = summary.avgTokens;

  summary.successRate = result.metrics.success
    ? prevSuccessRate + (1 - prevSuccessRate) / summary.runCount
    : prevSuccessRate * (1 - 1 / summary.runCount);

  summary.avgDuration =
    prevAvgDuration +
    (result.metrics.durationSeconds - prevAvgDuration) / summary.runCount;
  summary.avgCost =
    prevAvgCost + (result.metrics.totalCost - prevAvgCost) / summary.runCount;
  summary.avgTokens =
    prevAvgTokens +
    (result.metrics.totalTokens - prevAvgTokens) / summary.runCount;

  if (
    result.provenance.kind === "measured" &&
    result.provenance.runDate > summary.latestRun
  ) {
    summary.latestRun = result.provenance.runDate;
  }
}

// Load history if requested
let history: TrackerEntry[] = [];
if (includeHistory) {
  const historyPath = join("tracker", "history.json");
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf-8"));
    } catch {
      console.warn("  ⚠️  Failed to load history");
    }
  }
}

// Generate insights
const insights: string[] = [];

// Compare agents if requested
if (compare) {
  const agentSummaries = new Map<string, TaskAgentSummary[]>();

  for (const summary of summaries.values()) {
    const agent = summary.agentType;
    if (!agentSummaries.has(agent)) {
      agentSummaries.set(agent, []);
    }
    agentSummaries.get(agent)!.push(summary);
  }

  for (const [agent, agentData] of agentSummaries) {
    const avgSuccess =
      agentData.reduce((sum, s) => sum + s.successRate, 0) / agentData.length;
    const avgCost =
      agentData.reduce((sum, s) => sum + s.avgCost, 0) / agentData.length;
    const avgDuration =
      agentData.reduce((sum, s) => sum + s.avgDuration, 0) / agentData.length;

    insights.push(
      `${agent}: ${(avgSuccess * 100).toFixed(1)}% success rate, ` +
        `$${avgCost.toFixed(2)} avg cost, ${avgDuration.toFixed(1)}s avg duration`,
    );
  }
}

// Build report
const report: BenchmarkReport = {
  metadata: {
    id: `report-${Date.now()}`,
    title: compare ? "Agent Comparison Report" : "Benchmark Report",
    generatedAt: new Date().toISOString(),
    dateRange: {
      start: results.reduce((min, r) => {
        const date =
          r.provenance.kind === "measured" ? r.provenance.runDate : "";
        return date < min ? date : min;
      }, ""),
      end: results.reduce((max, r) => {
        const date =
          r.provenance.kind === "measured" ? r.provenance.runDate : "";
        return date > max ? date : max;
      }, ""),
    },
    agents: [...new Set(results.map((r) => r.agent.type))],
    taskIds: [...new Set(results.map((r) => r.taskId))],
  },
  summaries: Array.from(summaries.values()),
  results,
  history,
  insights: insights.length > 0 ? insights : undefined,
};

// Ensure output directory exists
const outputDir = outputFile.substring(0, outputFile.lastIndexOf("/"));
mkdirSync(outputDir, { recursive: true });

// Write report
console.log(`\n📝 Generating ${format.toUpperCase()} report...`);

switch (format) {
  case "json":
    writeFileSync(outputFile, JSON.stringify(report, null, 2));
    break;

  case "markdown":
    writeFileSync(outputFile, generateMarkdownReport(report));
    break;

  case "html":
  default:
    writeFileSync(outputFile, generateHtmlReport(report));
    break;
}

console.log(`\n✅ Report written to ${outputFile}`);
console.log();

/**
 * Generate HTML report
 */
function generateHtmlReport(report: BenchmarkReport): string {
  const { metadata, summaries, results, history, insights } = report;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.title} — Arena Benchmark</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.5rem; margin: 2rem 0 1rem; border-bottom: 2px solid #e5e5e5; padding-bottom: 0.5rem; }
    h3 { font-size: 1.25rem; margin: 1.5rem 0 0.5rem; }
    .meta { color: #666; font-size: 0.875rem; margin-bottom: 2rem; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .summary-card {
      background: white;
      padding: 1.5rem;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .summary-card .label { color: #666; font-size: 0.875rem; }
    .summary-card .value { font-size: 2rem; font-weight: 600; margin-top: 0.25rem; }
    .insights {
      background: #e8f4fd;
      padding: 1.5rem;
      border-radius: 8px;
      margin-bottom: 2rem;
    }
    .insights ul { margin-top: 0.5rem; padding-left: 1.5rem; }
    table {
      width: 100%;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      border-collapse: collapse;
    }
    th, td { padding: 1rem; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    tr:not(:last-child) td { border-bottom: 1px solid #e5e5e5; }
    .success { color: #16a34a; }
    .failure { color: #dc2626; }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-oxagen { background: #dbeafe; color: #1e40af; }
    .badge-stella { background: #fef3c7; color: #92400e; }
    .badge-claude-code { background: #fce7f3; color: #9f1239; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${metadata.title}</h1>
    <div class="meta">
      Generated ${new Date(metadata.generatedAt).toLocaleString()} ·
      ${results.length} results ·
      ${metadata.agents.join(", ")}
    </div>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="label">Total Results</div>
        <div class="value">${results.length}</div>
      </div>
      <div class="summary-card">
        <div class="label">Success Rate</div>
        <div class="value">${((results.filter((r) => r.metrics.success).length / results.length) * 100).toFixed(1)}%</div>
      </div>
      <div class="summary-card">
        <div class="label">Total Cost</div>
        <div class="value">$${results.reduce((sum, r) => sum + r.metrics.totalCost, 0).toFixed(2)}</div>
      </div>
      <div class="summary-card">
        <div class="label">Total Duration</div>
        <div class="value">${Math.floor(results.reduce((sum, r) => sum + r.metrics.durationSeconds, 0) / 60)}m</div>
      </div>
    </div>

    ${
      insights
        ? `
    <div class="insights">
      <h3>💡 Insights</h3>
      <ul>
        ${insights.map((i) => `<li>${i}</li>`).join("")}
      </ul>
    </div>
    `
        : ""
    }

    <h2>Task-Agent Summaries</h2>
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th>Agent</th>
          <th>Model</th>
          <th>Runs</th>
          <th>Success Rate</th>
          <th>Avg Duration</th>
          <th>Avg Cost</th>
        </tr>
      </thead>
      <tbody>
        ${summaries
          .map(
            (s) => `
          <tr>
            <td>${s.taskId}</td>
            <td><span class="badge badge-${s.agentType}">${s.agentType}</span></td>
            <td><code>${s.model}</code></td>
            <td>${s.runCount}</td>
            <td class="${s.successRate >= 0.5 ? "success" : "failure"}">${(s.successRate * 100).toFixed(0)}%</td>
            <td>${s.avgDuration.toFixed(1)}s</td>
            <td>$${s.avgCost.toFixed(2)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>

    <h2>Individual Results</h2>
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th>Agent</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Tokens</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${results
          .map(
            (r) => `
          <tr>
            <td>${r.taskId}</td>
            <td><span class="badge badge-${r.agent.type}">${r.agent.type}</span></td>
            <td class="${r.metrics.success ? "success" : "failure"}">${r.metrics.success ? "✓ Passed" : "✗ Failed"}</td>
            <td>${r.metrics.durationSeconds.toFixed(1)}s</td>
            <td>${r.metrics.totalTokens.toLocaleString()}</td>
            <td>$${r.metrics.totalCost.toFixed(2)}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>

    ${
      history && history.length > 0
        ? `
    <h2>Progress Tracking</h2>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Agent</th>
          <th>Success Rate</th>
          <th>Avg Cost</th>
          <th>Avg Duration</th>
          <th>Tasks Completed</th>
        </tr>
      </thead>
      <tbody>
        ${history
          .map(
            (h) => `
          <tr>
            <td>${new Date(h.date).toLocaleDateString()}</td>
            <td>${h.agentType}</td>
            <td>${(h.successRate * 100).toFixed(1)}%</td>
            <td>$${h.avgCost.toFixed(2)}</td>
            <td>${h.avgDuration.toFixed(1)}s</td>
            <td>${h.tasksCompleted}</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
    `
        : ""
    }
  </div>
</body>
</html>`;
}

/**
 * Generate Markdown report
 */
function generateMarkdownReport(report: BenchmarkReport): string {
  const { metadata, summaries, results, history, insights } = report;

  let md = `# ${metadata.title}\n\n`;
  md += `Generated ${new Date(metadata.generatedAt).toLocaleString()}\n\n`;
  md += `**Summary:** ${results.length} results across ${metadata.agents.join(", ")}\n\n`;

  md += `## Overall Metrics\n\n`;
  md += `- **Total Results:** ${results.length}\n`;
  md += `- **Success Rate:** ${((results.filter((r) => r.metrics.success).length / results.length) * 100).toFixed(1)}%\n`;
  md += `- **Total Cost:** $${results.reduce((sum, r) => sum + r.metrics.totalCost, 0).toFixed(2)}\n`;
  md += `- **Total Duration:** ${Math.floor(results.reduce((sum, r) => sum + r.metrics.durationSeconds, 0) / 60)} minutes\n\n`;

  if (insights) {
    md += `## 💡 Insights\n\n`;
    for (const insight of insights) {
      md += `- ${insight}\n`;
    }
    md += "\n";
  }

  md += `## Task-Agent Summaries\n\n`;
  md += `| Task | Agent | Model | Runs | Success Rate | Avg Duration | Avg Cost |\n`;
  md += `|------|-------|-------|------|--------------|--------------|----------|\n`;

  for (const s of summaries) {
    md += `| ${s.taskId} | ${s.agentType} | \`${s.model}\` | ${s.runCount} | ${(s.successRate * 100).toFixed(0)}% | ${s.avgDuration.toFixed(1)}s | $${s.avgCost.toFixed(2)} |\n`;
  }

  md += `\n## Individual Results\n\n`;
  md += `| Task | Agent | Status | Duration | Tokens | Cost |\n`;
  md += `|------|-------|--------|----------|--------|------|\n`;

  for (const r of results) {
    md += `| ${r.taskId} | ${r.agent.type} | ${r.metrics.success ? "✓" : "✗"} | ${r.metrics.durationSeconds.toFixed(1)}s | ${r.metrics.totalTokens.toLocaleString()} | $${r.metrics.totalCost.toFixed(2)} |\n`;
  }

  return md;
}
