import { schema, withSystemDb } from "@oxagen/database";

/**
 * Register (or refresh) a GitHub App installation in the platform-scoped
 * `ingestion.github_installations` catalog. Idempotent on `installation_id`.
 *
 * A GitHub App installation is a singleton per GitHub account shared across
 * Oxagen tenants, so this table is NOT tenant-scoped — it is the source of truth
 * for installation identity + lifecycle. The App webhook is the authoritative
 * maintainer, but the connect/list/callback paths also upsert here so the
 * registry is populated from the user's own authoritative view without waiting
 * for a webhook. `reactivate` (fresh install / unsuspend) clears any prior
 * suspend/uninstall; a plain metadata refresh (e.g. a listing) leaves lifecycle
 * flags untouched so it can never accidentally un-suspend an installation.
 *
 * Lives in its own module (not github-oauth.ts) so the callback + webhook that
 * call it can be unit-tested with this seam mocked to a no-op — an intra-module
 * call can't be intercepted by vi.mock.
 */
export async function upsertGithubInstallation(input: {
  installationId: string;
  accountLogin?: string | null;
  accountId?: string | null;
  accountType?: string | null;
  appSlug?: string | null;
  repositorySelection?: string | null;
  reactivate?: boolean;
  suspendedAt?: Date | null;
  deletedAt?: Date | null;
}): Promise<void> {
  const now = new Date();

  // Lifecycle: an explicit suspend/delete override wins; else `reactivate`
  // (fresh install / unsuspend) clears both; else the flags are left untouched
  // (a metadata refresh from a listing must never un-suspend an installation).
  const lifecycle: { suspendedAt?: Date | null; deletedAt?: Date | null } = {};
  if (input.suspendedAt !== undefined)
    lifecycle.suspendedAt = input.suspendedAt;
  if (input.deletedAt !== undefined) lifecycle.deletedAt = input.deletedAt;
  if (input.reactivate && input.suspendedAt === undefined)
    lifecycle.suspendedAt = null;
  if (input.reactivate && input.deletedAt === undefined)
    lifecycle.deletedAt = null;

  await withSystemDb((tx) =>
    tx
      .insert(schema.githubInstallations)
      .values({
        installationId: input.installationId,
        accountLogin: input.accountLogin ?? null,
        accountId: input.accountId ?? null,
        accountType: input.accountType ?? null,
        appSlug: input.appSlug ?? null,
        repositorySelection: input.repositorySelection ?? null,
        suspendedAt: lifecycle.suspendedAt ?? null,
        deletedAt: lifecycle.deletedAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.githubInstallations.installationId,
        set: {
          // Never null out a known value with an unknown one — only overwrite
          // metadata when this caller actually has it (the callback leg carries
          // only the id; the listing/webhook legs carry account details).
          ...(input.accountLogin != null
            ? { accountLogin: input.accountLogin }
            : {}),
          ...(input.accountId != null ? { accountId: input.accountId } : {}),
          ...(input.accountType != null
            ? { accountType: input.accountType }
            : {}),
          ...(input.appSlug != null ? { appSlug: input.appSlug } : {}),
          ...(input.repositorySelection != null
            ? { repositorySelection: input.repositorySelection }
            : {}),
          ...lifecycle,
          updatedAt: now,
        },
      }),
  );
}
