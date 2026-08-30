/**
 * registry-default — single-default registry state machine.
 *
 * Rules (from the approved workspace-scoping design):
 *
 *   add:
 *     count (orgId, workspaceId) rows in the same tx.
 *     0 exist → is_default = true
 *     ≥1 exist → is_default = false
 *     There is NO user-facing API to set/toggle the default.
 *
 *   remove:
 *     Allowed for ANY registry, including the default.
 *     After deletion, if the removed row WAS the default AND ≥1 row remains →
 *       promote the most-recently-created remaining row (created_at DESC, LIMIT 1).
 *     If the removed row was not the default, or no rows remain → no promotion.
 *     The delete + optional promotion MUST be called inside one transaction to
 *     keep the partial unique index consistent.
 *
 *   invariant:
 *     With exactly 1 registry for a workspace it is always is_default=true.
 *     There is no "set_default" capability — do not add one.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { logger } from "./logger";

export interface AddRegistryInput {
  orgId: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
}

export interface AddRegistryResult {
  id: string;
  isDefault: boolean;
}

export interface RemoveRegistryInput {
  orgId: string;
  workspaceId: string;
  registryId: string;
}

export interface RemoveRegistryResult {
  /** true when a row was found and deleted */
  removed: boolean;
  /** id of the row promoted to default after deleting the default; null otherwise */
  promotedId: string | null;
}

/**
 * Inserts a new registry row, automatically setting is_default=true iff no
 * registry exists yet for (orgId, workspaceId).  Must be called inside a
 * caller-owned transaction.
 */
export async function addRegistry(
  tx: Tx,
  { orgId, workspaceId, name, baseUrl }: AddRegistryInput,
): Promise<AddRegistryResult> {
  // Count existing rows for this workspace in the same tx — atomically decides default.
  const countRows = await tx
    .select({ count: sql<string>`count(*)` })
    .from(schema.mcpRegistries)
    .where(
      and(
        eq(schema.mcpRegistries.orgId, orgId),
        eq(schema.mcpRegistries.workspaceId, workspaceId),
      ),
    );

  const existingCount = parseInt(countRows[0]?.count ?? "0", 10);
  const isDefault = existingCount === 0;

  const rows = await tx
    .insert(schema.mcpRegistries)
    .values({ orgId, workspaceId, name, baseUrl, enabled: true, isDefault })
    .returning({ id: schema.mcpRegistries.id });

  const row = rows[0];
  if (!row) throw new Error("registry insert returned no row");

  logger.info(
    { registryId: row.id, orgId, workspaceId, isDefault },
    "addRegistry: inserted",
  );

  return { id: row.id, isDefault };
}

/**
 * Removes a registry row by (orgId, workspaceId, registryId).  If the deleted
 * row was the default and ≥1 row remains, promotes the most-recently-created
 * remaining row to is_default=true.
 *
 * MUST be called inside a caller-owned transaction — delete + promote are one
 * atomic unit so the partial unique index (org_id, workspace_id) WHERE is_default
 * never sees two defaults simultaneously.
 */
export async function removeRegistry(
  tx: Tx,
  { orgId, workspaceId, registryId }: RemoveRegistryInput,
): Promise<RemoveRegistryResult> {
  // Delete the row — scope to (orgId, workspaceId, registryId) for tenancy safety.
  const deleted = await tx
    .delete(schema.mcpRegistries)
    .where(
      and(
        eq(schema.mcpRegistries.id, registryId),
        eq(schema.mcpRegistries.orgId, orgId),
        eq(schema.mcpRegistries.workspaceId, workspaceId),
      ),
    )
    .returning({
      id: schema.mcpRegistries.id,
      isDefault: schema.mcpRegistries.isDefault,
    });

  if (deleted.length === 0) {
    logger.warn(
      { registryId, orgId, workspaceId },
      "removeRegistry: no row matched",
    );
    return { removed: false, promotedId: null };
  }

  const removedRow = deleted[0]!;

  if (!removedRow.isDefault) {
    // Non-default removed — no promotion needed.
    logger.info(
      { registryId: removedRow.id, orgId, workspaceId },
      "removeRegistry: non-default removed",
    );
    return { removed: true, promotedId: null };
  }

  // The default was removed.  Find the most-recently-created remaining row.
  const remaining = await tx
    .select({ id: schema.mcpRegistries.id })
    .from(schema.mcpRegistries)
    .where(
      and(
        eq(schema.mcpRegistries.orgId, orgId),
        eq(schema.mcpRegistries.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(schema.mcpRegistries.createdAt))
    .limit(1);

  if (remaining.length === 0) {
    // No rows left — nothing to promote.
    logger.info(
      { registryId: removedRow.id, orgId, workspaceId },
      "removeRegistry: default removed, no remaining rows",
    );
    return { removed: true, promotedId: null };
  }

  const toPromote = remaining[0]!;

  await tx
    .update(schema.mcpRegistries)
    .set({ isDefault: true })
    .where(eq(schema.mcpRegistries.id, toPromote.id));

  logger.info(
    { removedId: removedRow.id, promotedId: toPromote.id, orgId, workspaceId },
    "removeRegistry: default removed + promoted most-recent",
  );

  return { removed: true, promotedId: toPromote.id };
}
