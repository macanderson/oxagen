/**
 * Benchmark Run Cancel API Route.
 *
 * Kills every child process group of the run (tsx → runner → CLI → any
 * container) and marks it cancelled. Idempotent. For a full machine-wide
 * teardown (including Docker trial containers), use `pnpm bench:kill`.
 */

import { NextResponse } from "next/server";

import { cancelRun } from "@/lib/run-registry";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const record = cancelRun(id);
  if (!record) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({
    runId: record.runId,
    status: record.status,
    jobs: record.jobs,
  });
}
