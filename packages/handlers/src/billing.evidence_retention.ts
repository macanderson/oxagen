// audit-exempt: read-only — reports the caller's own retention posture and retention credits already charged; mutates nothing. The kernel capability.invoke_* audit covers access.
/**
 * get_evidence_retention handler (ADR-052 §4.3, spec §7.4).
 *
 * The second meter's posture, read from three places and guessed in none:
 *
 *   - `RETENTION_INCLUDED_MONTHS` / `RETENTION_USD_PER_GB_MONTH` — the
 *     published price, shared with the code that charges it.
 *   - `billing.org_billing_settings.extended_evidence_retention_enabled` — the
 *     opt-in, which is the field that decides whether anything can accrue at
 *     all. No row means never opted in, which is `false`.
 *   - `evidence.retention_policy_versions` — the longest window the
 *     organisation's own pinned policies declare.
 *
 * The stored-volume field is the one this capability cannot answer yet: no
 * accounting job measures evidence bytes per organisation. It returns null with
 * `storedGbMeasured: false` rather than zero, because zero is a claim ("you are
 * storing nothing") and null is the truth ("nobody has counted").
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  CREDIT_REASONS,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  actionPeriodStart,
} from "@oxagen/billing";
import { logger } from "./logger";

export const billingEvidenceRetentionHandler: CapabilityHandler<
  typeof billingEvidenceRetention
> = async (_input, ctx) => {
  // The same entitlement window the action meter uses (`actionPeriodStart`), so
  // "this period" means one thing across the two capabilities a customer reads
  // side by side. Retention is raised monthly; this sums the year's raises.
  const periodStart = actionPeriodStart(new Date());
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear() + 1, 0, 1));

  const [settingsRows, policyRows, ledgerRows] = await withTenantDb(
    async (tx) => {
      const settings = await tx
        .select({
          extendedEvidenceRetentionEnabled:
            schema.orgBillingSettings.extendedEvidenceRetentionEnabled,
        })
        .from(schema.orgBillingSettings)
        .where(eq(schema.orgBillingSettings.orgId, ctx.orgId))
        .limit(1);

      // Across every workspace of the organisation: the contract asks for the
      // longest window ANY pinned policy declares, and retention is billed to
      // the org, not the workspace.
      const policies = await tx
        .select({
          maxTtlDays: sql<
            number | null
          >`max(${schema.retentionPolicyVersions.ttlDays})`,
        })
        .from(schema.retentionPolicyVersions)
        .where(eq(schema.retentionPolicyVersions.orgId, ctx.orgId));

      const ledger = await tx
        .select({
          total: sql<string>`coalesce(sum(${schema.creditLedger.deltaCents}), 0)`,
        })
        .from(schema.creditLedger)
        .where(
          and(
            eq(schema.creditLedger.orgId, ctx.orgId),
            eq(schema.creditLedger.reason, CREDIT_REASONS.CONSUME_RETENTION),
            gte(schema.creditLedger.createdAt, periodStart),
            lt(schema.creditLedger.createdAt, periodEnd),
          ),
        );

      return [settings, policies, ledger] as const;
    },
  );

  // No settings row means the organisation never opted in. Defaulting to false
  // is the whole point of §7.4 — an absent row must never be read as consent.
  const extendedRetentionEnabled =
    settingsRows[0]?.extendedEvidenceRetentionEnabled ?? false;

  // `max()` over an empty set is SQL NULL. Null means "no policy pinned", which
  // is NOT "kept forever" and NOT zero — the column's CHECK keeps ttl_days > 0,
  // so a real answer is always positive and null can only mean absence.
  const rawMaxTtl = policyRows[0]?.maxTtlDays;
  const maxTtlDays =
    rawMaxTtl === null || rawMaxTtl === undefined ? null : Number(rawMaxTtl);
  const effectiveRetentionDays =
    maxTtlDays !== null && Number.isFinite(maxTtlDays) && maxTtlDays > 0
      ? Math.floor(maxTtlDays)
      : null;

  // A debit is a negative delta; report its magnitude.
  const total = BigInt(ledgerRows[0]?.total ?? "0");
  const creditsChargedThisPeriod = Number(total < 0n ? -total : 0n);

  logger.info(
    {
      orgId: ctx.orgId,
      surface: ctx.surface,
      extendedRetentionEnabled,
      effectiveRetentionDays,
      creditsChargedThisPeriod,
      periodStart: periodStart.toISOString(),
    },
    "get_evidence_retention: returned retention posture",
  );

  return {
    includedMonths: RETENTION_INCLUDED_MONTHS,
    effectiveRetentionDays,
    extendedRetentionEnabled,
    usdPerGbMonth: RETENTION_USD_PER_GB_MONTH,
    // No accounting job measures per-organisation evidence volume yet. Null
    // plus `storedGbMeasured: false` says "not counted"; a zero would say "you
    // are storing nothing", which is a different claim and probably a false
    // one. When the job lands, both fields change together.
    storedGbBeyondIncluded: null,
    storedGbMeasured: false,
    creditsChargedThisPeriod,
  };
};
