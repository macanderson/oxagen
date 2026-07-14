/**
 * Results API Route
 *
 * Returns benchmark results with filtering and pagination.
 */

import { NextResponse } from "next/server";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

import type { BenchmarkResult } from "@/lib/types";

const RESULTS_DIR = "results/";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Parse filters
  const agentType = searchParams.get("agentType");
  const taskId = searchParams.get("taskId");
  const limit = parseInt(searchParams.get("limit") ?? "50");
  const offset = parseInt(searchParams.get("offset") ?? "0");

  // Collect results
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
        } catch {
          // Skip invalid files
        }
      }
    }
  }

  scanDirectory(RESULTS_DIR);

  // Apply filters
  let filtered = results;

  if (agentType) {
    filtered = filtered.filter(r => r.agent.type === agentType);
  }

  if (taskId) {
    filtered = filtered.filter(r => r.taskId === taskId);
  }

  // Sort by date (newest first)
  filtered.sort((a, b) => {
    const aDate = a.provenance.kind === "measured" ? a.provenance.runDate : "";
    const bDate = b.provenance.kind === "measured" ? b.provenance.runDate : "";
    return bDate.localeCompare(aDate);
  });

  // Paginate
  const paginated = filtered.slice(offset, offset + limit);

  return NextResponse.json({
    results: paginated,
    total: filtered.length,
    offset,
    limit
  });
}
