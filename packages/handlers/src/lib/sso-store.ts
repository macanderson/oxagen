/**
 * The queries behind the org.sso.* handlers (ADR-142). Every function takes
 * the transaction its caller opened and pins `orgId` in every predicate.
 *
 * The callers open that transaction with withSystemDb, and each call site
 * says why. In short: `auth.sso_providers` is a platform table with no RLS
 * that lives on the shared plane (ADR-042), `org.sso_group_roles` has a
 * foreign key into it, and a provider delete must turn the SSO requirement
 * off in the same transaction. The `orgId` predicate here is the tenant
 * fence, so no function in this file may take a row by id alone.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import type { SsoGroupRole } from "@oxagen/oxagen/contracts/org.sso.shared";
import type { SsoGroupRoleRow, SsoProviderRow } from "./sso";

const providers = schema.ssoProviderTable;
const groupRoles = schema.ssoGroupRoles;
const policy = schema.orgSecurityPolicy;

/** The organisation's providers, oldest first. */
export async function listOrgSsoProviders(
  tx: Tx,
  orgId: string,
): Promise<SsoProviderRow[]> {
  return tx
    .select()
    .from(providers)
    .where(eq(providers.organizationId, orgId))
    .orderBy(asc(providers.createdAt));
}

/** One provider, or null when it is missing or belongs to another org. */
export async function findOrgSsoProvider(
  tx: Tx,
  orgId: string,
  providerId: string,
): Promise<SsoProviderRow | null> {
  const [row] = await tx
    .select()
    .from(providers)
    .where(
      and(
        eq(providers.organizationId, orgId),
        eq(providers.providerId, providerId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The group-to-role rows for the given providers, by group name. */
export async function listOrgSsoGroupRoles(
  tx: Tx,
  orgId: string,
  providerIds: readonly string[],
): Promise<SsoGroupRoleRow[]> {
  if (providerIds.length === 0) return [];
  return tx
    .select({
      providerId: groupRoles.providerId,
      idpGroup: groupRoles.idpGroup,
      role: groupRoles.role,
    })
    .from(groupRoles)
    .where(
      and(
        eq(groupRoles.orgId, orgId),
        inArray(groupRoles.providerId, [...providerIds]),
      ),
    )
    .orderBy(asc(groupRoles.idpGroup));
}

/** Whether the organisation requires SSO. No policy row means it does not. */
export async function readOrgSsoRequired(
  tx: Tx,
  orgId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ ssoRequired: policy.ssoRequired })
    .from(policy)
    .where(eq(policy.orgId, orgId))
    .limit(1);
  return row?.ssoRequired ?? false;
}

/** How many of the organisation's providers have a verified domain. */
export async function countVerifiedOrgSsoProviders(
  tx: Tx,
  orgId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(providers)
    .where(
      and(
        eq(providers.organizationId, orgId),
        eq(providers.domainVerified, true),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Whether any account row already uses `providerId` as its provider id. An
 * SSO provider must never share one with another account source, because
 * Better Auth matches an existing account by (providerId, accountId) before
 * it checks the email (see RESERVED_SSO_PROVIDER_IDS). This is the one query
 * in this file that is not org-scoped: auth.accounts is global identity, and
 * the answer is a yes/no about the id, never a row.
 */
export async function accountProviderIdInUse(
  tx: Tx,
  providerId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.providerId, providerId))
    .limit(1);
  return row !== undefined;
}

export async function insertOrgSsoProvider(
  tx: Tx,
  values: typeof providers.$inferInsert,
): Promise<SsoProviderRow> {
  const [row] = await tx.insert(providers).values(values).returning();
  if (!row) throw new Error("create_sso_provider: the provider was not stored");
  return row;
}

export async function updateOrgSsoProvider(
  tx: Tx,
  orgId: string,
  providerId: string,
  patch: Partial<typeof providers.$inferInsert>,
): Promise<SsoProviderRow | null> {
  const [row] = await tx
    .update(providers)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(providers.organizationId, orgId),
        eq(providers.providerId, providerId),
      ),
    )
    .returning();
  return row ?? null;
}

/** Delete one provider. Its group-to-role rows go with it (ON DELETE CASCADE). */
export async function deleteOrgSsoProvider(
  tx: Tx,
  orgId: string,
  providerId: string,
): Promise<SsoProviderRow | null> {
  const [row] = await tx
    .delete(providers)
    .where(
      and(
        eq(providers.organizationId, orgId),
        eq(providers.providerId, providerId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Set `sso_required`, creating the policy row when the organisation has none.
 * Only the SSO column and the audit stamps change, so the MFA settings on the
 * same row are kept.
 */
export async function upsertOrgSsoRequired(
  tx: Tx,
  orgId: string,
  ssoRequired: boolean,
  actorUserId: string | null,
): Promise<void> {
  const now = new Date();
  await tx
    .insert(policy)
    .values({ orgId, ssoRequired, updatedById: actorUserId })
    .onConflictDoUpdate({
      target: policy.orgId,
      set: { ssoRequired, updatedById: actorUserId, updatedAt: now },
    });
}

/** Replace a provider's group-to-role table with `mappings`. */
export async function replaceOrgSsoGroupRoles(
  tx: Tx,
  orgId: string,
  providerId: string,
  mappings: readonly SsoGroupRole[],
  actorUserId: string | null,
): Promise<void> {
  await tx
    .delete(groupRoles)
    .where(
      and(eq(groupRoles.orgId, orgId), eq(groupRoles.providerId, providerId)),
    );
  if (mappings.length === 0) return;
  await tx.insert(groupRoles).values(
    mappings.map((m) => ({
      orgId,
      providerId,
      idpGroup: m.group,
      role: m.role,
      createdById: actorUserId,
      updatedById: actorUserId,
    })),
  );
}
