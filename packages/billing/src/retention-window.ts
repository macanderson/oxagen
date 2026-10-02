/**
 * retention-window.ts: the evidence window an organisation's billing basis
 * includes today (ADR-241, signup grant; #3844).
 *
 * `includedRetentionDays` maps a basis to its window. This reads the basis
 * the gate would read, so `get_evidence_retention` and the Price list agree
 * on what an organisation keeps. An organisation approved for invoice
 * billing keeps a subscriber's window, because it is billed like one.
 *
 * Billing state lives on the shared plane (ADR-042 §2), so the reads run
 * through `withSystemDb` with the organisation as their predicate, and the
 * caller needs no workspace scope.
 */

import { withSystemDb } from "@oxagen/database";
import { includedRetentionDays } from "./action-metering";
import { readOrgBillingSettings } from "./billing-settings";
import { readGauEntitlement } from "./contract-terms";
import { bucketBasis } from "./gau-bucket";

/** The evidence window, in days, the organisation's basis includes at `now`. */
export async function resolveIncludedRetentionDays(
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const settings = await readOrgBillingSettings(orgId, { system: true });
  if (settings.approvedForInvoiceBilling) {
    return includedRetentionDays("subscription");
  }
  // tenancy: billing state is on the shared plane, and this read is filtered
  // by orgId, which the calling handler scoped through assertContractRole.
  const entitlement = await withSystemDb((tx) =>
    readGauEntitlement(tx, orgId, now),
  );
  return includedRetentionDays(bucketBasis(entitlement, now).kind);
}
