import { clusterErrorEvents } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import type {
  TelemetryErrorClusterInput,
  TelemetryErrorClusterOutput,
} from "@oxagen/oxagen/contracts/telemetry.error.cluster";

export type { TelemetryErrorClusterInput, TelemetryErrorClusterOutput };

const DEFAULT_SINCE_HOURS = 24;
/** Bounded sample-message clamp — mirrors debug-frame.ts's MESSAGE_CLAMP. */
const SAMPLE_MESSAGE_CLAMP = 600;

/**
 * telemetry.error.cluster (telemetry_error_cluster) — deterministic-first
 * error triage overview. ADR-021 §1/§3: pure SQL, ZERO model calls — a
 * bounded GROUP BY over ClickHouse `error_events` clustered by `fingerprint`,
 * so an agent/operator sees the SHAPE of what's failing platform-wide (error
 * class, occurrence count, first/last seen) instead of a raw event firehose.
 * Complements `agent.debug.trace` (single-execution failure frame).
 */
export async function telemetryErrorClusterHandler(
  input: TelemetryErrorClusterInput,
  ctx: CapabilityContext,
): Promise<TelemetryErrorClusterOutput> {
  const sinceHours = input.sinceHours ?? DEFAULT_SINCE_HOURS;
  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;

  const { clusters, totalErrors, distinctClusters } = await clusterErrorEvents({
    orgId: ctx.orgId,
    sinceMs,
    severity: input.severity,
    source: input.source,
    limit: input.limit,
  });

  return {
    clusters: clusters.map((c) => ({
      fingerprint: c.fingerprint,
      errorClass: c.errorClass,
      sampleMessage: clampSampleMessage(c.sampleMessage),
      severity: c.severity,
      source: c.source,
      count: c.count,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
    })),
    totalErrors,
    distinctClusters,
    truncated: distinctClusters > clusters.length,
    window: { sinceHours },
  };
}

function clampSampleMessage(
  message: string,
  max = SAMPLE_MESSAGE_CLAMP,
): string {
  return message.length > max
    ? `${message.slice(0, max)}… [truncated]`
    : message;
}
