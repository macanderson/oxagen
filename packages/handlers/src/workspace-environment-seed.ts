/**
 * workspace-environment-seed — idempotent default-environment seeder for new
 * workspaces (Spec §15). Every workspace gets exactly one environment with
 * is_default=true so runs always resolve to a default. Called inside (or
 * immediately after) the workspace-creation transaction.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { logger } from "./logger";

export const DEFAULT_ENVIRONMENT_NAME = "Default";
export const DEFAULT_ENVIRONMENT_SLUG = "default";

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
  const [existing] = await tx
    .select({ id: schema.environments.id })
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.orgId, orgId),
        eq(schema.environments.workspaceId, workspaceId),
        eq(schema.environments.slug, DEFAULT_ENVIRONMENT_SLUG),
        isNull(schema.environments.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    logger.info(
      { environmentId: existing.id, orgId, workspaceId },
      "workspace-environment-seed: default environment already exists, skipping insert",
    );
    return existing.id;
  }

  const [row] = await tx
    .insert(schema.environments)
    .values({
      orgId,
      workspaceId,
      name: DEFAULT_ENVIRONMENT_NAME,
      slug: DEFAULT_ENVIRONMENT_SLUG,
      isDefault: true,
      isActive: true,
    })
    .returning({ id: schema.environments.id });

  if (!row) throw new Error("environment insert returned no row");
  logger.info(
    { environmentId: row.id, orgId, workspaceId },
    "workspace-environment-seed: default environment seeded",
  );
  return row.id;
}

/**
 * Idempotently seeds the default environment for a workspace. Pass `tx` to run
 * inside a caller-owned transaction (handlers within an ALS tenant scope), or
 * omit to open a fresh `withTenantDb` session.
 */
export async function seedWorkspaceDefaultEnvironment({
  orgId,
  workspaceId,
  tx: callerTx,
}: SeedArgs): Promise<string> {
  if (callerTx) return runSeed(callerTx, orgId, workspaceId);
  return withTenantDb((tx) => runSeed(tx, orgId, workspaceId));
}

/**
 * `withSystemDb` (RLS-bypassing) variant for Server Actions and backfill
 * scripts where there is no ALS tenant scope (withTenantDb would throw
 * TenantScopeError). Mirrors seedWorkspaceDefaultRegistrySystem.
 */
export async function seedWorkspaceDefaultEnvironmentSystem({
  orgId,
  workspaceId,
}: Omit<SeedArgs, "tx">): Promise<string> {
  return withSystemDb((tx) => runSeed(tx, orgId, workspaceId));
}
