/**
 * The transactions billing opens inside a tenant scope.
 *
 * Billing tables are platform tables. ADR-042 §2 keeps them on the shared
 * plane for every organisation, including one whose tenant data lives on its
 * own database (a dedicated plane). `withTenantDb` on its own opens such an
 * organisation's transaction on that database. Stripe webhooks grant credits
 * on the shared plane, and settled usage lands there too (ADR-134). A balance
 * read on the dedicated plane then reads an empty table, and the turn credit
 * gate stops seeing the debits it exists to count (#4338).
 *
 * Both seams set the tenant GUCs, so RLS still fences every row. They call the
 * `@oxagen/database` exports by name, so a unit test that substitutes
 * `withTenantDb` or `withOrgDb` covers them with no change to its mock.
 *
 * Only billing tables belong here. A tenant-data table read on the shared
 * plane finds none of a dedicated-plane organisation's rows.
 */
import { withOrgDb, withTenantDb, type Tx } from "@oxagen/database";

/** A workspace-scoped billing transaction on the shared plane. */
export function withBillingDb<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantDb(run, { plane: "shared" });
}

/** An organisation-wide billing read on the shared plane (ADR-086). */
export function withBillingOrgDb<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withOrgDb(run, { plane: "shared" });
}
