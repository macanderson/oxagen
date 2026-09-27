// The workspace's operator pseudonym setting (spend spec, Operator ranking).
//
// One row per workspace in workspace.operator_ranking_policy. No row means
// the setting is off. The row holds a random salt, written once when the row
// is created and never returned. A pseudonym is `Operator` and the first
// eight hex digits of HMAC-SHA256(salt, principal public id), so it stays the
// same for one operator in one workspace while the setting is on, and the
// salt keeps it from being read back by hashing a known id.
import { createHmac } from "node:crypto";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

export type PseudonymScope = { orgId: string; workspaceId: string };

export type PseudonymPolicy = { pseudonyms: boolean; salt: string | null };

const policy = schema.operatorRankingPolicy;

/** `Operator` and eight uppercase hex digits for one principal public id. */
export function operatorPseudonym(salt: string, operatorKey: string): string {
  const digest = createHmac("sha256", salt).update(operatorKey).digest("hex");
  return `Operator ${digest.slice(0, 8).toUpperCase()}`;
}

/** The setting for the workspace; off with no salt when no row exists. */
export async function readPseudonymPolicy(
  scope: PseudonymScope,
): Promise<PseudonymPolicy> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        pseudonyms: policy.pseudonyms,
        salt: policy.pseudonymSalt,
      })
      .from(policy)
      .where(
        and(
          eq(policy.orgId, scope.orgId),
          eq(policy.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  return row
    ? { pseudonyms: row.pseudonyms, salt: row.salt }
    : { pseudonyms: false, salt: null };
}

/** Turn the setting on or off. The salt is written with the row and kept after. */
export async function writePseudonymPolicy(
  scope: PseudonymScope,
  enabled: boolean,
  actorUserId: string,
): Promise<{ pseudonyms: boolean }> {
  const rows = await withTenantDb((tx) =>
    tx
      .insert(policy)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        pseudonyms: enabled,
        updatedById: actorUserId,
      })
      .onConflictDoUpdate({
        target: policy.workspaceId,
        set: {
          pseudonyms: enabled,
          updatedById: actorUserId,
          updatedAt: new Date(),
        },
      })
      .returning({ pseudonyms: policy.pseudonyms }),
  );
  return { pseudonyms: rows[0]?.pseudonyms ?? enabled };
}
