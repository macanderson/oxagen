/**
 * Start Benchmark API Route
 *
 * Initiates a benchmark run with the specified configuration.
 * Returns a run ID for tracking progress.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { validateRunConfig } from "@/lib/schema";
import type { RunConfig } from "@/lib/types";
import { setProgress } from "../progress/[runId]/route";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Validate configuration
    const configResult = validateRunConfig(body);

    if (!configResult.success) {
      return NextResponse.json(
        { error: "Invalid configuration", issues: configResult.error.issues },
        { status: 400 }
      );
    }

    const config = configResult.data as RunConfig;

    // Generate run ID
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // Initialize progress state
    setProgress(runId, {
      runId,
      status: "queued",
      startTime: Date.now(),
      totalTasks: 3, // Default to smoke test count
      completedTasks: 0,
      results: [],
      totalCost: 0,
      totalTokens: 0,
      errors: [],
    });

    // Start the benchmark run asynchronously (in production, use a job queue)
    startBenchmarkRun(runId, config).catch(error => {
      console.error(`Benchmark run ${runId} failed:`, error);
      setProgress(runId, {
        status: "failed",
        errors: [error.message],
      });
    });

    return NextResponse.json({
      runId,
      status: "queued",
      config,
      message: "Benchmark run queued successfully"
    });
  } catch (error) {
    console.error("Error starting benchmark:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Simulated benchmark run (in production, this would run the actual agents)
 */
async function startBenchmarkRun(runId: string, config: RunConfig) {
  const tasks = [
    { id: "smoke-add-import", name: "Add Missing Import" },
    { id: "smoke-fix-typos", name: "Fix Typos in Comments" },
    { id: "smoke-add-error-handling", name: "Add Error Handling" },
  ];

  // Update status to running
  setProgress(runId, {
    status: "running",
    totalTasks: tasks.length,
  });

  // Simulate running each task
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    // Set current task
    setProgress(runId, {
      currentTask: {
        id: task.id,
        name: task.name,
        agent: config.agents[0]?.type || "unknown",
        model: config.agents[0]?.model || "unknown",
        status: "running",
        progress: 0,
        tokensUsed: 0,
        costSoFar: 0,
        duration: 0,
      },
    });

    // Simulate task progress
    for (let progress = 0; progress <= 100; progress += 10) {
      await new Promise(resolve => setTimeout(resolve, 200));
      setProgress(runId, {
        currentTask: {
          id: task.id,
          name: task.name,
          agent: config.agents[0]?.type || "unknown",
          model: config.agents[0]?.model || "unknown",
          status: "running",
          progress,
          tokensUsed: progress * 50,
          costSoFar: progress * 0.001,
          duration: progress * 0.5,
        },
      });
    }

    // Task completed
    setProgress(runId, {
      completedTasks: i + 1,
      currentTask: undefined,
      results: [
        {
          taskId: task.id,
          taskName: task.name,
          agent: config.agents[0]?.type || "unknown",
          model: config.agents[0]?.model || "unknown",
          success: Math.random() > 0.2, // 80% success rate
          duration: 50 + Math.random() * 20,
          cost: 0.05 + Math.random() * 0.02,
          tokens: 5000 + Math.floor(Math.random() * 1000),
        },
      ],
      totalCost: (i + 1) * 0.05,
      totalTokens: (i + 1) * 5000,
    });
  }

  // Mark as completed
  setProgress(runId, {
    status: "completed",
    endTime: Date.now(),
  });
}
