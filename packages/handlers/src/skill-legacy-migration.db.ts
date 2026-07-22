import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { hashSkillBody, type SkillVersionRow } from "./skill-legacy-migration";

/**
 * Database side of the Markdown → canonical TOML skill backfill. The decision
 * rules live in `./skill-legacy-migration` and stay pure; this module only
 * moves rows.
 */

/**
 * Enumerate every skill version with its skill's slug.
 *
 * Crossing tenants is the point — the backfill must find legacy rows wherever
 * they are — which is exactly the documented `withSystemDb` case: a trusted
 * system job. It is read-only; nothing is written under the RLS bypass.
 */
export async function loadSkillVersionRows(): Promise<SkillVersionRow[]> {
  return withSystemDb(async (tx) => {
    const rows = await tx
      .select({
        id: schema.skillVersions.id,
        publicId: schema.skillVersions.publicId,
        orgId: schema.skillVersions.orgId,
        workspaceId: schema.skillVersions.workspaceId,
        skillId: schema.skillVersions.skillId,
        slug: schema.skills.slug,
        versionNumber: schema.skillVersions.versionNumber,
        body: schema.skillVersions.body,
        legacyBody: schema.skillVersions.legacyBody,
      })
      .from(schema.skillVersions)
      .innerJoin(
        schema.skills,
        eq(schema.skills.id, schema.skillVersions.skillId),
      )
      .orderBy(schema.skillVersions.createdAt);
    return rows as SkillVersionRow[];
  });
}

/**
 * Convert one row inside its OWN tenant scope, so RLS stays load-bearing on
 * the write path and the mutation is attributed to the owning org/workspace
 * rather than performed under a system-wide bypass.
 *
 * The `legacy_body IS NULL` predicate is the idempotency guard: a row already
 * carrying preserved provenance is never rewritten, so concurrent or repeated
 * runs cannot double-convert or clobber the original bytes. Returns false when
 * another run got there first.
 */
export async function convertSkillVersionRow(
  row: SkillVersionRow,
  content: string,
): Promise<boolean> {
  return runInTenantScope(
    { orgId: row.orgId, workspaceId: row.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const updated = await tx
          .update(schema.skillVersions)
          .set({
            body: content,
            checksum: hashSkillBody(content),
            legacyBody: row.body,
            legacyBodyChecksum: hashSkillBody(row.body),
            migratedAt: new Date(),
          })
          .where(
            and(
              eq(schema.skillVersions.id, row.id),
              isNull(schema.skillVersions.legacyBody),
            ),
          )
          .returning({ id: schema.skillVersions.id });
        return updated.length > 0;
      }),
  );
}
