/**
 * Workspace environments. CRUD plus the only-one-default invariant with
 * promote-before-remove semantics. The default swap is atomic in one tx;
 * the DB partial-unique `(workspace_id) WHERE is_default` is the backstop, the
 * handler guards are the user-facing contract. RLS-enforced via withTenantDb.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

export interface EnvironmentActor {
  orgId: string;
  workspaceId: string;
  userId?: string | null;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
}

/** Lowercase handle: starts alnum, inner alnum/hyphen, ends alnum. */
export const ENVIRONMENT_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function isValidEnvironmentSlug(slug: string): boolean {
  return ENVIRONMENT_SLUG_PATTERN.test(slug);
}

// Built per call, never at module scope: test suites mock @oxagen/database
// with a partial `schema`, and a module-level `schema.<table>.<col>` access
// crashes every importer at load time.
const envColumns = () =>
  ({
    id: schema.environments.id,
    publicId: schema.environments.publicId,
    name: schema.environments.name,
    slug: schema.environments.slug,
    description: schema.environments.description,
    isDefault: schema.environments.isDefault,
    isActive: schema.environments.isActive,
  }) as const;

interface EnvRow {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
}

function toSummary(row: EnvRow): EnvironmentSummary {
  return {
    id: row.publicId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isDefault: row.isDefault,
    isActive: row.isActive,
  };
}

async function loadEnv(
  tx: Tx,
  workspaceId: string,
  publicId: string,
): Promise<EnvRow> {
  const [row] = await tx
    .select(envColumns())
    .from(schema.environments)
    .where(
      and(
        eq(schema.environments.workspaceId, workspaceId),
        eq(schema.environments.publicId, publicId),
        isNull(schema.environments.deletedAt),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(`[environments] environment not found: ${publicId}`);
  return row;
}

export async function createEnvironment(
  actor: EnvironmentActor,
  input: { name: string; slug: string; description?: string | null },
): Promise<EnvironmentSummary> {
  const slug = input.slug.toLowerCase();
  if (!isValidEnvironmentSlug(slug)) {
    throw new Error(`[environments] invalid slug: ${input.slug}`);
  }
  return withTenantDb(async (tx) => {
    const [row] = await tx
      .insert(schema.environments)
      .values({
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        name: input.name,
        slug,
        description: input.description ?? null,
        isDefault: false,
        isActive: true,
        createdByUserId: actor.userId ?? null,
        updatedByUserId: actor.userId ?? null,
      })
      .returning(envColumns());
    if (!row) throw new Error("[environments] insert returned no row");
    return toSummary(row);
  });
}

export async function listEnvironments(
  actor: EnvironmentActor,
): Promise<EnvironmentSummary[]> {
  return withTenantDb(async (tx) => {
    const rows = await tx
      .select(envColumns())
      .from(schema.environments)
      .where(
        and(
          eq(schema.environments.workspaceId, actor.workspaceId),
          isNull(schema.environments.deletedAt),
        ),
      )
      .orderBy(schema.environments.slug);
    return rows.map(toSummary);
  });
}

export async function getEnvironment(
  actor: EnvironmentActor,
  input: { environmentId: string },
): Promise<EnvironmentSummary> {
  return withTenantDb(async (tx) =>
    toSummary(await loadEnv(tx, actor.workspaceId, input.environmentId)),
  );
}

export async function updateEnvironment(
  actor: EnvironmentActor,
  input: {
    environmentId: string;
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
  },
): Promise<EnvironmentSummary> {
  return withTenantDb(async (tx) => {
    const existing = await loadEnv(tx, actor.workspaceId, input.environmentId);
    // The default environment must always stay active — promote another
    // environment to default before deactivating this one.
    if (input.isActive === false && existing.isDefault) {
      throw new Error(
        "[environments] cannot deactivate the default environment — promote another environment to default first",
      );
    }
    const slug =
      input.slug !== undefined ? input.slug.toLowerCase() : undefined;
    if (slug !== undefined && !isValidEnvironmentSlug(slug)) {
      throw new Error(`[environments] invalid slug: ${input.slug}`);
    }
    const [row] = await tx
      .update(schema.environments)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      })
      .where(eq(schema.environments.id, existing.id))
      .returning(envColumns());
    if (!row) throw new Error("[environments] update returned no row");
    return toSummary(row);
  });
}

export async function deleteEnvironment(
  actor: EnvironmentActor,
  input: { environmentId: string },
): Promise<{ ok: true }> {
  await withTenantDb(async (tx) => {
    const existing = await loadEnv(tx, actor.workspaceId, input.environmentId);
    if (existing.isDefault) {
      throw new Error(
        "[environments] cannot delete the default environment — promote another environment to default first",
      );
    }
    await tx
      .update(schema.environments)
      .set({ deletedAt: new Date(), deletedByUserId: actor.userId ?? null })
      .where(eq(schema.environments.id, existing.id));
  });
  return { ok: true };
}

/**
 * Atomically promote an environment to the workspace default: unset the current
 * default, then set the target (and reactivate it — the default is always
 * active). One tx; the partial-unique never observes two defaults.
 */
export async function setDefaultEnvironment(
  actor: EnvironmentActor,
  input: { environmentId: string },
): Promise<EnvironmentSummary> {
  return withTenantDb(async (tx) => {
    const target = await loadEnv(tx, actor.workspaceId, input.environmentId);
    // Clear the existing default first so the partial-unique sees at most one.
    await tx
      .update(schema.environments)
      .set({
        isDefault: false,
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      })
      .where(
        and(
          eq(schema.environments.workspaceId, actor.workspaceId),
          eq(schema.environments.isDefault, true),
          isNull(schema.environments.deletedAt),
        ),
      );
    const [row] = await tx
      .update(schema.environments)
      .set({
        isDefault: true,
        isActive: true,
        updatedAt: new Date(),
        updatedByUserId: actor.userId ?? null,
      })
      .where(eq(schema.environments.id, target.id))
      .returning(envColumns());
    if (!row) throw new Error("[environments] set_default returned no row");
    return toSummary(row);
  });
}
