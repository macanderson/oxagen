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
 *
 * TWO SEAMS, DELIBERATELY, BECAUSE THE THREE READS ARE NOT THE SAME KIND OF
 * DATA.
 *
 * The settings row and the credit ledger are billing state. ADR-042 §2 puts
 * billing on the shared plane always, so `withSystemDb` is their seam and the
 * eq(orgId) predicate is their isolation.
 *
 * The policy aggregate is neither. It is deliberately organisation-wide — "the
 * longest window ANY pinned policy declares" — over
 * `evidence.retention_policy_versions`, which is policy class `standard`
 * (packages/database/src/tenant-policy.manifest.ts), so its RLS USING clause
 * requires workspace_id to equal the workspace GUC and a tenant-scoped read
 * could only ever answer for one workspace. That much this handler always got
 * wrong. But `withSystemDb` is not the fix on its own: it ALWAYS opens the
 * shared plane and never consults `resolveDataPlane` (see its docblock), and
 * ADR-042 §2 names evidence as tenant data a dedicated plane carries. For an
 * organisation bound to a dedicated Postgres plane, a shared-plane read finds
 * no policies at all and `max()` over the empty set is SQL NULL, which the
 * mapping below reads as "no policy pinned" — the same wrong answer the
 * workspace narrowing produced, arriving by a different route.
 *
 * There is no plane-aware organisation-wide seam in `@oxagen/database` today:
 * `withTenantDb` resolves the plane but demands a workspace, and `withSystemDb`
 * needs no workspace but is shared-plane by construction. Building one is a
 * change to the store client and not this handler's to make, so this refuses
 * rather than guesses: a dedicated-plane organisation gets a typed error, and
 * every organisation today is shared (ADR-042 §1 — absence of a row means
 * shared, and the dedicated mode has no customer yet), so nothing in service
 * reaches the refusal. A wrong number that looks right is what this whole
 * capability exists to avoid.
 */

import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { schema, withSystemDb } from "@oxagen/database";
import { assertDataPlaneUsable, resolveDataPlane } from "@oxagen/tenancy";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  CREDIT_REASONS,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  actionPeriodStart,
} from "@oxagen/billing";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const billingEvidenceRetentionHandler: CapabilityHandler<
  typeof billingEvidenceRetention
> = async (_input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(billingEvidenceRetention, ctx);
  // ADR-042: the policy aggregate below is tenant evidence state, and
  // withSystemDb is shared-plane by construction. Refuse before reading rather
  // than report a dedicated-plane organisation's evidence as absent.
  //
  // BOTH CHECKS, because `withTenantDb` was doing both. It resolves the plane
  // AND calls `assertDataPlaneUsable`, which refuses any binding that is not
  // `active`. Standing in for it with a mode check alone kept the first
  // guarantee and dropped the second, so an organisation whose shared binding
  // an operator had explicitly disabled or marked degraded would have had its
  // retention posture read off that plane anyway — the data-plane kill switch,
  // bypassed. `assertDataPlaneUsable` is the same helper every other
  // plane-aware path uses; a local status check here would be a second answer
  // to "is this binding usable".
  //
  // ORDER: the mode check first. A dedicated plane cannot be read here at all,
  // whatever its status, so that is the cause worth naming; a disabled shared
  // binding then refuses for its own reason with its own error.
  const plane = await resolveDataPlane(ctx.orgId, "postgres");
  if (plane.mode !== "shared") {
    logger.error(
      { orgId: ctx.orgId, planeMode: plane.mode },
      "get_evidence_retention: refused — no plane-aware organisation-wide read for evidence.retention_policy_versions",
    );
    // A plain Error, not a HandlerError: the three handler codes are
    // forbidden / not_found / conflict, and this is none of them. Nothing the
    // caller did is wrong and nothing about their tenant's state forbids the
    // read — the platform has a gap. That is a 5xx, which is what an untyped
    // throw becomes at every surface.
    throw new Error(
      "get_evidence_retention cannot answer for an organisation on a dedicated Postgres plane: " +
        "the organisation-wide policy aggregate over evidence.retention_policy_versions has no " +
        "plane-aware seam yet, and withSystemDb would read the shared plane and report the " +
        "organisation's pinned policies as absent.",
    );
  }
  // Throws DataPlaneUnavailableError for any binding that is not active.
  assertDataPlaneUsable(plane);

  // The same entitlement window the action meter uses (`actionPeriodStart`), so
  // "this period" means one thing across the two capabilities a customer reads
  // side by side. Retention is raised monthly; this sums the year's raises.
  const periodStart = actionPeriodStart(new Date());
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear() + 1, 0, 1));

  const [settingsRows, policyRows, ledgerRows] = await withSystemDb(
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
