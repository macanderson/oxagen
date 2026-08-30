import { z } from "zod";
import { registerCapability } from "../registry";

// telemetry.error.cluster (telemetry_error_cluster — dots→underscores via
// toModelToolName) — deterministic-first error triage overview. ADR-021 §3:
// instead of dumping every captured error row into the model's context, this
// clusters ClickHouse `error_events` by `fingerprint` (a bounded GROUP BY) and
// returns a small, typed list of error CLASSES — how often each is firing and
// since when — so an agent/operator sees the SHAPE of what's failing
// platform-wide, not a raw event firehose. ADR-021 §1: pure SQL, ZERO model
// calls — this is a fleet-wide histogram, not a diagnosis.
//
// Complements `debug_execution` (single-execution failure frame): that
// capability answers "why did THIS run fail"; this one answers "what error
// classes are burning across the org right now".

const errorCluster = z.object({
  fingerprint: z
    .string()
    .describe(
      "Stable grouping key (SHA-256 of error_class + normalized message)",
    ),
  errorClass: z
    .string()
    .describe("Error constructor name (e.g. 'TypeError', 'CapabilityError')"),
  sampleMessage: z
    .string()
    .describe("Bounded sample message from the most recent occurrence"),
  severity: z.enum(["fatal", "error", "warn"]),
  source: z
    .string()
    .describe(
      "Server runtime that captured the error (api|app|mcp|inngest|runner)",
    ),
  count: z
    .number()
    .int()
    .describe("Occurrences of this fingerprint within the window"),
  firstSeen: z
    .string()
    .describe("Earliest occurrence timestamp within the window"),
  lastSeen: z
    .string()
    .describe("Latest occurrence timestamp within the window"),
});

export const telemetryErrorCluster = registerCapability({
  name: "list_error_clusters",
  domain: "telemetry",
  description:
    "Cluster recent captured errors by fingerprint to see which error classes are recurring and how often across the org — the triage overview. Prefer this over reading raw errors when you want the SHAPE of what's failing platform-wide. Anti-trigger: to diagnose ONE specific failed execution (failing step, stack, suspect files) use debug_execution; this is the fleet-wide histogram, not a single-run frame.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    sinceHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .optional()
      .describe("Lookback window in hours (default: 24, max: 720 / 30 days)"),
    severity: z
      .enum(["fatal", "error", "warn"])
      .optional()
      .describe("Restrict to one severity (default: all)"),
    source: z
      .string()
      .optional()
      .describe(
        "Restrict to one capturing runtime, e.g. 'api' | 'app' | 'mcp' | 'inngest' | 'runner' (default: all)",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Max distinct clusters to return, ranked by occurrence count (default: 20)",
      ),
  }),
  output: z.object({
    clusters: z
      .array(errorCluster)
      .describe("Error classes ranked by occurrence count, highest first"),
    totalErrors: z
      .number()
      .int()
      .describe(
        "Total error occurrences in the window (across all clusters, not just the returned page)",
      ),
    distinctClusters: z
      .number()
      .int()
      .describe(
        "Total distinct fingerprints in the window (may exceed `clusters.length` when truncated)",
      ),
    truncated: z
      .boolean()
      .describe("True when distinctClusters exceeds the returned `limit`"),
    window: z.object({
      sinceHours: z
        .number()
        .int()
        .describe("Effective lookback window in hours actually applied"),
    }),
  }),
});

export type TelemetryErrorClusterInput = z.output<
  typeof telemetryErrorCluster.input
>;
export type TelemetryErrorClusterOutput = z.output<
  typeof telemetryErrorCluster.output
>;
