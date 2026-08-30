import { schema, withTenantDb } from "@oxagen/database";
import {
  normalizeRoutingPolicy,
  resolveEffectiveRoutingPolicy,
  type MarketRoutingPolicy,
  type ResolvedRoutingPolicy,
  type RoutingMode,
} from "@oxagen/agent-engine";

// Shared loader for the Verified-Outcome Market Router governance rows. The
// get / list / preview handlers all resolve the effective policy the same way,
// so the DB read + normalization lives here once. The pure resolution + the
// policy shape live in @oxagen/agent-engine (resolveEffectiveRoutingPolicy).

/** Normalize a free-text stored mode to a canonical value, defaulting to "off". */
export function normalizeRoutingMode(
  raw: string | null | undefined,
): RoutingMode {
  return raw === "shadow" || raw === "enforce" ? raw : "off";
}

interface StoredRoutingRow {
  mode: string;
  successThreshold: number;
  minSamples: number;
  windowDays: number;
  escalateOnRejection: boolean;
}

/** Turn a stored routing_policy row into a normalized MarketRoutingPolicy. */
export function rowToRoutingPolicy(row: StoredRoutingRow): MarketRoutingPolicy {
  return normalizeRoutingPolicy({
    mode: normalizeRoutingMode(row.mode),
    successThreshold: row.successThreshold,
    minSamples: row.minSamples,
    windowDays: row.windowDays,
    escalateOnRejection: row.escalateOnRejection,
  });
}

/**
 * Load the org-level (workspace_id NULL) and workspace-level routing_policy rows
 * for the active tenant scope and resolve the effective policy (workspace > org
 * > OFF default). RLS restricts the read to exactly the org-default row plus this
 * workspace's own row, so a full-table read returns at most two rows.
 */
export async function loadEffectiveRoutingPolicy(ctx: {
  workspaceId: string | null;
}): Promise<ResolvedRoutingPolicy> {
  const rows = await withTenantDb((tx) =>
    tx.query.routingPolicy.findMany({
      columns: {
        workspaceId: true,
        mode: true,
        successThreshold: true,
        minSamples: true,
        windowDays: true,
        escalateOnRejection: true,
      },
    }),
  );
  const orgRow = rows.find((r) => r.workspaceId === null);
  const wsRow = ctx.workspaceId
    ? rows.find((r) => r.workspaceId === ctx.workspaceId)
    : undefined;
  return resolveEffectiveRoutingPolicy(
    orgRow ? rowToRoutingPolicy(orgRow) : null,
    wsRow ? rowToRoutingPolicy(wsRow) : null,
  );
}

// Re-export the schema handle so callers don't reach past this module for the table.
export const routingPolicyTable = schema.routingPolicy;
