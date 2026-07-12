/**
 * Benchmark Progress API Route
 *
 * Returns the current progress state of a benchmark run.
 * Supports polling for real-time updates.
 */

import { NextResponse } from "next/server";

import type { BenchmarkProgressState } from "@/components/benchmark-progress-live";

// In-memory store for progress (in production, use Redis or similar)
const progressStore = new Map<string, BenchmarkProgressState>();

/**
 * Store progress state for a run
 */
export function setProgress(runId: string, progress: Partial<BenchmarkProgressState>) {
  const existing = progressStore.get(runId);
  progressStore.set(runId, {
    ...existing,
    ...progress,
  } as BenchmarkProgressState);
}

/**
 * Get progress state for a run
 */
export function getProgress(runId: string): BenchmarkProgressState | undefined {
  return progressStore.get(runId);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  const progress = getProgress(runId);

  if (!progress) {
    return NextResponse.json(
      { error: "Run not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(progress);
}

/**
 * Update progress state (internal use)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  try {
    const body = (await request.json()) as Partial<BenchmarkProgressState>;
    setProgress(runId, body);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
}
