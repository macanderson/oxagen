/**
 * billing-settings.ts — per-org billing automation settings.
 *
 * Handles auto-reload preferences and dunning state for each org. The
 * `org_billing_settings` row is created on first access (upsert semantics)
 * so callers never deal with a missing row.
 */

import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ── Public types ──────────────────────────────────────────────────────────────

export interface OrgBillingSettings {
  orgId: string;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: number; // Number(bigint)
  autoReloadAmountCents: number;
  autoReloadPaymentMethodId: string | null;
  lastAutoReloadAt: Date | null;
  lowBalanceThresholdCents: number;
  dunningState: "active" | "grace" | "suspended";
  delinquentSince: Date | null;
  graceEndsAt: Date | null;
  suspendedAt: Date | null;
}

// ── Internal defaults ─────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_CENTS = 500;
const DEFAULT_AMOUNT_CENTS = 2_000;
const DEFAULT_LOW_BALANCE_THRESHOLD_CENTS = 500;
const MIN_RELOAD_AMOUNT_CENTS = 100; // $1.00 minimum

// ── Mapping helper ────────────────────────────────────────────────────────────

function rowToSettings(row: {
  orgId: string;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: bigint;
  autoReloadAmountCents: bigint;
  autoReloadPaymentMethodId: string | null;
  lastAutoReloadAt: Date | null;
  lowBalanceThresholdCents: bigint;
  dunningState: string;
  delinquentSince: Date | null;
  graceEndsAt: Date | null;
  suspendedAt: Date | null;
}): OrgBillingSettings {
  return {
    orgId: row.orgId,
    autoReloadEnabled: row.autoReloadEnabled,
    autoReloadThresholdCents: Number(row.autoReloadThresholdCents),
    autoReloadAmountCents: Number(row.autoReloadAmountCents),
    autoReloadPaymentMethodId: row.autoReloadPaymentMethodId,
    lastAutoReloadAt: row.lastAutoReloadAt,
    lowBalanceThresholdCents: Number(row.lowBalanceThresholdCents),
    dunningState: row.dunningState as "active" | "grace" | "suspended",
    delinquentSince: row.delinquentSince,
    graceEndsAt: row.graceEndsAt,
    suspendedAt: row.suspendedAt,
  };
}

// ── getOrgBillingSettings ─────────────────────────────────────────────────────

/**
 * Return the org's billing settings, creating a default row if none exists.
 *
 * Uses INSERT ON CONFLICT DO NOTHING followed by a SELECT so the function is
 * idempotent and race-condition safe. The DB unique constraint on org_id
 * (`org_billing_settings_org_idx`) ensures at most one row per org.
 */
export async function getOrgBillingSettings(
  orgId: string,
): Promise<OrgBillingSettings> {
  const start = Date.now();

  const row = await withTenantDb(async (tx) => {
    // Attempt to create a default row; silently no-ops if one already exists.
    await tx
      .insert(schema.orgBillingSettings)
      .values({
        orgId,
        autoReloadEnabled: false,
        autoReloadThresholdCents: BigInt(DEFAULT_THRESHOLD_CENTS),
        autoReloadAmountCents: BigInt(DEFAULT_AMOUNT_CENTS),
        autoReloadPaymentMethodId: null,
        lowBalanceThresholdCents: BigInt(DEFAULT_LOW_BALANCE_THRESHOLD_CENTS),
        dunningState: "active",
        delinquentSince: null,
        graceEndsAt: null,
        suspendedAt: null,
        lastDunningNotifiedAt: null,
      })
      .onConflictDoNothing();

    return tx.query.orgBillingSettings.findFirst({
      where: eq(schema.orgBillingSettings.orgId, orgId),
    });
  });

  if (!row) {
    // Should never happen after the insert above, but guard defensively.
    throw new Error(`billing-settings: failed to resolve settings for org ${orgId}`);
  }

  logger.debug(
    { orgId, durationMs: Date.now() - start },
    "billing: org billing settings resolved",
  );

  return rowToSettings(row);
}

// ── updateAutoReloadSettings ──────────────────────────────────────────────────

export interface UpdateAutoReloadInput {
  enabled?: boolean;
  thresholdCents?: number;
  amountCents?: number;
  paymentMethodId?: string | null;
}

/**
 * Update the org's auto-reload preferences.
 *
 * Validates:
 *   - thresholdCents >= 0
 *   - amountCents >= 100 (minimum $1.00 per reload)
 *
 * Ensures the settings row exists first (via getOrgBillingSettings) so
 * partial updates always have a base row to update.
 */
export async function updateAutoReloadSettings(
  orgId: string,
  input: UpdateAutoReloadInput,
): Promise<OrgBillingSettings> {
  const start = Date.now();

  // Validate inputs before any DB writes.
  if (input.thresholdCents !== undefined && input.thresholdCents < 0) {
    throw new Error("billing-settings: thresholdCents must be >= 0");
  }
  if (
    input.amountCents !== undefined &&
    input.amountCents < MIN_RELOAD_AMOUNT_CENTS
  ) {
    throw new Error(
      `billing-settings: amountCents must be >= ${MIN_RELOAD_AMOUNT_CENTS} (minimum $1.00)`,
    );
  }

  // Ensure a settings row exists before updating.
  await getOrgBillingSettings(orgId);

  // Build the partial update object — only include keys that were supplied.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) patch.autoReloadEnabled = input.enabled;
  if (input.thresholdCents !== undefined)
    patch.autoReloadThresholdCents = BigInt(input.thresholdCents);
  if (input.amountCents !== undefined)
    patch.autoReloadAmountCents = BigInt(input.amountCents);
  if ("paymentMethodId" in input)
    patch.autoReloadPaymentMethodId = input.paymentMethodId ?? null;

  await withTenantDb((tx) =>
    tx
      .update(schema.orgBillingSettings)
      .set(patch)
      .where(eq(schema.orgBillingSettings.orgId, orgId)),
  );

  // Re-read the updated row.
  const updated = await getOrgBillingSettings(orgId);

  logger.info(
    { orgId, patch, durationMs: Date.now() - start },
    "billing: auto-reload settings updated",
  );

  return updated;
}
