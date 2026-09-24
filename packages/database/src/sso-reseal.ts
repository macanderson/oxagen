/**
 * Re-seal every SSO provider's secrets under the current key (ADR-145).
 *
 * After AUTH_TOKEN_ENCRYPTION_KEY rotates, the old key stays in
 * SSO_SECRET_PREVIOUS_KEYS so existing tokens still open. This job moves each
 * token sealed under a retired key id onto the current one. Once a run reports
 * no failures and nothing left to move, the retired key can leave the keyring.
 *
 * Each row is handled on its own. A row that cannot be opened is reported in
 * `failed` with its reason, and the other rows are still re-sealed. The update
 * is conditional on the column still holding the text that was read, so an
 * admin's edit made during the run is never overwritten. That row is reported
 * as failed and the next run picks it up.
 *
 * The inngest-functions package schedules this daily and on the
 * `auth/sso-secrets.reseal.requested` event.
 */
import { and, eq } from "drizzle-orm";
import { ssoProviderTable } from "./schema/auth";
import {
  resealSsoConfig,
  resolveSsoKms,
  type ResolvedSsoKms,
  type SsoProtocol,
} from "./sso-secrets";
import { withSystemDb } from "./tenant";

export interface SsoResealFailure {
  readonly providerId: string;
  readonly reason: string;
}

export interface SsoResealResult {
  /** Provider rows read. */
  readonly scanned: number;
  /** Rows written back with every token under the current key. */
  readonly resealed: number;
  /** Rows left as they were, with the reason. */
  readonly failed: SsoResealFailure[];
  /** Set when the run did nothing because no current key is configured. */
  readonly skipped?: string;
}

const CONFIG_COLUMNS = [
  ["oidcConfig", "oidc"],
  ["samlConfig", "saml"],
] as const satisfies readonly (readonly [string, SsoProtocol])[];

type ConfigColumn = (typeof CONFIG_COLUMNS)[number][0];

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function resealSsoProviders(
  opts: { kms?: ResolvedSsoKms | null } = {},
): Promise<SsoResealResult> {
  const kms = opts.kms === undefined ? resolveSsoKms() : opts.kms;
  if (!kms) {
    return {
      scanned: 0,
      resealed: 0,
      failed: [],
      skipped: "AUTH_TOKEN_ENCRYPTION_KEY is not set",
    };
  }

  // tenancy: scheduled cross-tenant maintenance over auth.sso_providers for all orgs; the table has no org_id RLS, and the job rewrites only sealed tokens in place.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: ssoProviderTable.id,
        providerId: ssoProviderTable.providerId,
        oidcConfig: ssoProviderTable.oidcConfig,
        samlConfig: ssoProviderTable.samlConfig,
      })
      .from(ssoProviderTable),
  );

  let resealed = 0;
  const failed: SsoResealFailure[] = [];
  for (const row of rows) {
    const updates: Partial<Record<ConfigColumn, string>> = {};
    try {
      for (const [column, protocol] of CONFIG_COLUMNS) {
        const stored = row[column];
        if (typeof stored !== "string" || stored === "") continue;
        const next = await resealSsoConfig(protocol, stored, kms);
        if (next !== null) updates[column] = next;
      }
    } catch (err) {
      failed.push({ providerId: row.providerId, reason: reasonOf(err) });
      continue;
    }
    const changed = Object.keys(updates) as ConfigColumn[];
    if (changed.length === 0) continue;

    try {
      // tenancy: scheduled cross-tenant maintenance, filtered by the row id read above for all orgs; the predicate also pins each config to the text that was re-sealed.
      const written = await withSystemDb((tx) =>
        tx
          .update(ssoProviderTable)
          .set({ ...updates, updatedAt: new Date() })
          .where(
            and(
              eq(ssoProviderTable.id, row.id),
              ...changed.map((column) =>
                eq(ssoProviderTable[column], row[column] as string),
              ),
            ),
          )
          .returning({ id: ssoProviderTable.id }),
      );
      if (written.length === 0) {
        failed.push({
          providerId: row.providerId,
          reason:
            "The provider changed while it was being re-sealed. The next run retries it.",
        });
        continue;
      }
      resealed += 1;
    } catch (err) {
      failed.push({ providerId: row.providerId, reason: reasonOf(err) });
    }
  }

  return { scanned: rows.length, resealed, failed };
}
