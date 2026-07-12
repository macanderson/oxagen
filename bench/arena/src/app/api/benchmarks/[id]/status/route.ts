/**
 * Benchmark Run Status API Route.
 *
 * Returns the live status of a run (per-agent job states) plus a bounded tail
 * of its log so the dashboard can render progress without holding a socket.
 */

import { NextResponse } from "next/server";

import { getRun, readRunLog } from "@/lib/run-registry";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const record = getRun(id);
  if (!record) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({
    runId: record.runId,
    status: record.status,
    dryRun: record.dryRun,
    category: record.category,
    budget: record.budget,
    timeout: record.timeout,
    createdAt: record.createdAt,
    jobs: record.jobs,
    log: readRunLog(record.runId),
  });
}
