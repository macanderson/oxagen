/**
 * Compile telemetry — an opt-in reporting seam for `compile()` results.
 *
 * `compile()` does NOT call this itself. A surface that wants compile metrics
 * installs a sink with {@link setCompileTelemetrySink} at bootstrap and calls
 * {@link emitCompileTelemetry} with the window it got back; with no sink
 * installed every emit is a no-op. The event shape is flat and column-friendly
 * so a sink can write it straight to an append-only analytics table for
 * latency, cache-stability, and budget-utilization dashboards.
 */
import type { ContextWindow } from "./layout";
import type { TaskFrame } from "../retrieval/types";

export interface CompileTelemetryEvent {
  compile_id: string;
  org_id: string;
  workspace_id: string;
  session_id: string | null;
  agent_id: string | null;
  model_id: string;
  retrieval_ms: number;
  packing_ms: number;
  layout_ms: number;
  total_ms: number;
  candidates_retrieved: number;
  candidates_packed: number;
  candidates_compressed: number;
  candidates_evicted: number;
  budget_total: number;
  budget_used: number;
  budget_remaining: number;
  cache_stable_bytes: number;
  cache_total_bytes: number;
  cache_hit_rate: number;
  created_at: string;
}

/**
 * Telemetry sink function — injected so this module doesn't hard-depend
 * on @oxagen/telemetry at the package level.
 */
export type TelemetrySink = (event: CompileTelemetryEvent) => Promise<void>;

let _sink: TelemetrySink | null = null;

/**
 * Set the telemetry sink. Call once at surface bootstrap.
 */
export function setCompileTelemetrySink(sink: TelemetrySink): void {
  _sink = sink;
}

/**
 * Clear the sink (for tests).
 */
export function clearCompileTelemetrySinkForTests(): void {
  _sink = null;
}

/**
 * Emit compile telemetry. Best-effort — never throws.
 */
export async function emitCompileTelemetry(
  taskFrame: TaskFrame,
  window: ContextWindow,
): Promise<void> {
  if (!_sink) return;
  try {
    await _sink({
      compile_id: crypto.randomUUID(),
      org_id: taskFrame.namespace.org,
      workspace_id: taskFrame.namespace.workspace,
      session_id: taskFrame.sessionId ?? null,
      agent_id: taskFrame.agentId ?? null,
      model_id: taskFrame.modelId,
      retrieval_ms: window.metadata.retrievalMs,
      packing_ms: window.metadata.packingMs,
      layout_ms: window.metadata.layoutMs,
      total_ms: window.metadata.totalMs,
      candidates_retrieved: window.metadata.candidatesRetrieved,
      candidates_packed: window.metadata.candidatesPacked,
      candidates_compressed: window.metadata.candidatesCompressed,
      candidates_evicted: window.metadata.candidatesEvicted,
      budget_total: window.tokenUsage.total + window.tokenUsage.budgetRemaining,
      budget_used: window.tokenUsage.total,
      budget_remaining: window.tokenUsage.budgetRemaining,
      cache_stable_bytes: window.cachePrefix.stableBytes,
      cache_total_bytes: window.cachePrefix.totalBytes,
      cache_hit_rate: window.cachePrefix.hitRate,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort telemetry — never disrupt the compile path.
  }
}
