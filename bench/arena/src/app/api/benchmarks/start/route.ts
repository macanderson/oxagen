/**
 * Start Benchmark API Route — REAL, guarded execution.
 *
 * Spawns the actual `scripts/run-benchmark.ts` CLI (one child per enabled
 * agent) via the run registry and returns a run id the UI can poll. This is
 * NOT a simulation.
 *
 * Guardrails enforced here:
 *   • `dryRun` defaults to true — a spending run must be explicitly requested.
 *   • Per-agent budget is rejected above MAX_BUDGET_PER_AGENT.
 * See src/lib/run-registry.ts for the process-group teardown guarantee.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  MAX_BUDGET_PER_AGENT,
  RUN_CATEGORIES,
  startRun,
} from "@/lib/run-registry";

// child_process + fs → Node runtime, never cached.
export const dynamic = "force-dynamic";

const startSchema = z.object({
  agents: z
    .array(
      z.object({
        type: z.enum(["oxagen", "stella", "claude-code", "custom"]),
        model: z.string().min(1),
      }),
    )
    .min(1, "Enable at least one agent"),
  category: z.enum(RUN_CATEGORIES),
  budget: z.number().positive(),
  timeout: z.number().int().positive(),
  concurrent: z.number().int().positive().max(10).default(1),
  // Safe by default: the client must send `dryRun: false` to actually spend.
  dryRun: z.boolean().default(true),
});

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = startSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid configuration", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const config = parsed.data;

  // Budget cap guardrail — never accept a per-agent budget above the ceiling.
  if (config.budget > MAX_BUDGET_PER_AGENT) {
    return NextResponse.json(
      {
        error: `Budget $${String(config.budget)} exceeds the per-agent cap of $${String(MAX_BUDGET_PER_AGENT)}. Set ARENA_MAX_BUDGET to raise it.`,
      },
      { status: 400 },
    );
  }

  try {
    const record = startRun({
      agents: config.agents,
      category: config.category,
      budget: config.budget,
      timeout: config.timeout,
      concurrent: config.concurrent,
      dryRun: config.dryRun,
    });

    return NextResponse.json(
      {
        runId: record.runId,
        status: record.status,
        dryRun: record.dryRun,
        jobs: record.jobs,
        statusUrl: `/api/benchmarks/${record.runId}/status`,
        message: record.dryRun
          ? "Dry run started — planning only, no agents will spend."
          : "Live benchmark run started.",
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("Error starting benchmark:", error);
    return NextResponse.json(
      { error: "Failed to start benchmark run" },
      { status: 500 },
    );
  }
}
