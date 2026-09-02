/**
 * workspace-registry-seed — idempotent default-registry seeder for new workspaces.
 *
 * Every workspace gets exactly one default MCP registry row. This module is
 * called inside (or immediately after) the workspace-creation transaction.
 *
 * Critical: registry-client appends /v0.1/servers to base_url at call time,
 * so we store the host root only — no path suffix.
 */
import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

/** Display name for the official MCP registry. */
export const OFFICIAL_MCP_REGISTRY_NAME = "Official MCP Registry";

/**
 * Root URL of the official MCP registry — no trailing path.
 * registry-client appends /v0.1/servers at fetch time.
 */
export const OFFICIAL_MCP_REGISTRY_BASE_URL =
  "https://registry.modelcontextprotocol.io";

interface SeedArgs {
  orgId: string;
  workspaceId: string;
  /** Pass an in-flight transaction to participate in the caller's transaction. */
  tx?: Tx;
}

async function runSeed(
  tx: Tx,
  orgId: string,
  workspaceId: string,
): Promise<string> {
  const existing = await tx.query.mcpRegistries.findFirst({
    where: and(
      eq(schema.mcpRegistries.orgId, orgId),
      eq(schema.mcpRegistries.workspaceId, workspaceId),
      eq(schema.mcpRegistries.baseUrl, OFFICIAL_MCP_REGISTRY_BASE_URL),
    ),
    columns: { id: true },
  });

  if (existing) {
    logger.info(
      { registryId: existing.id, orgId, workspaceId },
      "workspace-registry-seed: default registry already exists, skipping insert",
    );
    return existing.id;
  }

  const rows = await tx
    .insert(schema.mcpRegistries)
    .values({
      orgId,
      workspaceId,
      name: OFFICIAL_MCP_REGISTRY_NAME,
      baseUrl: OFFICIAL_MCP_REGISTRY_BASE_URL,
      isDefault: true,
      enabled: true,
    })
    .returning({ id: schema.mcpRegistries.id });

  const row = rows[0];
  if (!row) {
    throw new Error("registry insert returned no row");
  }

  logger.info(
    { registryId: row.id, orgId, workspaceId },
    "workspace-registry-seed: default registry seeded",
  );

  return row.id;
}

/**
 * Idempotently seeds the default MCP registry for a workspace.
 *
 * - Checks for an existing row on `(org_id, workspace_id, base_url)` first.
 * - Inserts with `is_default=true` and `enabled=true` if absent.
 * - Returns the registry id (new or existing).
 *
 * Pass `tx` to run inside a caller-owned transaction (e.g. workspace creation),
 * or omit to open a fresh `withTenantDb` session.
 */
export async function seedWorkspaceDefaultRegistry({
  orgId,
  workspaceId,
  tx: callerTx,
}: SeedArgs): Promise<string> {
  if (callerTx) {
    return runSeed(callerTx, orgId, workspaceId);
  }
  return withTenantDb((tx) => runSeed(tx, orgId, workspaceId));
}

/**
 * Variant of `seedWorkspaceDefaultRegistry` that opens a `withSystemDb`
 * (RLS-bypassing) session instead of `withTenantDb`.
 *
 * Use this from Server Actions and backfill scripts where there is no ALS
 * tenant scope — `withTenantDb` throws `TenantScopeError` in those contexts
 * because the ALS key (org_id / workspace_id) is not set.
 *
 * The original `seedWorkspaceDefaultRegistry` (tenant variant) is preserved
 * intact because it is called by handlers that already run inside an ALS scope.
 */
export async function seedWorkspaceDefaultRegistrySystem({
  orgId,
  workspaceId,
}: Omit<SeedArgs, "tx">): Promise<string> {
  return withSystemDb((tx) => runSeed(tx, orgId, workspaceId));
}
