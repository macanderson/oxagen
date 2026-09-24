/**
 * billing-settings.ts — per-org billing automation settings.
 *
 * Handles auto-reload preferences and dunning state for each org. Two
 * readers of the same row: `getOrgBillingSettings` creates a default row on
 * first access (upsert semantics) for the credits and dunning paths, and
 * `readOrgBillingSettings` is a plain SELECT for the GAU path (ADR-055 §5),
 * which answers with the column defaults for an org with no row and never
 * inserts, so a read never writes.
 */

import { withTenantDb, withSystemDb, schema, type Tx } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { billingProvider } from "./client";
import { logger } from "./logger";
import { readRecordedCustomerId } from "./recorded-customer";

// ── Public types ──────────────────────────────────────────────────────────────

export interface OrgBillingSettings {
  orgId: string;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: number; // Number(bigint)
  autoReloadAmountCents: number;
  autoReloadPaymentMethodId: string | null;
  lastAutoReloadAt: Date | null;
  lowBalanceThresholdCents: number;
  /** ADR-053 §3: monthly cap on platform-paid assistant tokens; null = no cap. */
  assistantSpendCapCents: number | null;
  dunningState: "active" | "grace" | "suspended";
  delinquentSince: Date | null;
  graceEndsAt: Date | null;
  suspendedAt: Date | null;
}

/**
 * The GAU billing mode and auto top-up preferences (ADR-055 §5). Read by the
 * gate, the recorder and `get_gau_bucket` through {@link readOrgBillingSettings}.
 */
export interface OrgGauBillingSettings {
  orgId: string;
  /** The org's Stripe customer, written once by ensureStripeCustomer. */
  stripeCustomerId: string | null;
  /** true → invoice billing (never capped); false → prepaid. */
  approvedForInvoiceBilling: boolean;
  /** Read only in invoice billing; stored and inert in prepaid. */
  invoiceGauMax: number;
  autoTopupEnabled: boolean;
  /** Blocks charged per auto top-up. */
  autoTopupBlocks: number;
  dunningState: "active" | "grace" | "suspended";
}

// ── Internal defaults ─────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_CENTS = 500;
const DEFAULT_AMOUNT_CENTS = 2_000;
const DEFAULT_LOW_BALANCE_THRESHOLD_CENTS = 500;
/** ADR-053 §3: $20 a month of platform-paid assistant tokens unless raised. */
export const DEFAULT_ASSISTANT_SPEND_CAP_CENTS = 2_000;
const MIN_RELOAD_AMOUNT_CENTS = 100; // $1.00 minimum

/**
 * The GAU columns' defaults (`packages/database/src/schema/billing.ts`,
 * org_billing_settings): what an org with no row is on. Prepaid, capped at
 * 100,000 uninvoiced GAUs should an operator approve invoice billing, auto
 * top-up on, one block per top-up.
 */
const GAU_SETTINGS_DEFAULTS = {
  stripeCustomerId: null,
  approvedForInvoiceBilling: false,
  invoiceGauMax: 100_000,
  autoTopupEnabled: true,
  autoTopupBlocks: 1,
  dunningState: "active",
} as const satisfies Omit<OrgGauBillingSettings, "orgId">;

// ── Mapping helper ────────────────────────────────────────────────────────────

function rowToSettings(row: {
  orgId: string;
  autoReloadEnabled: boolean;
  autoReloadThresholdCents: bigint;
  autoReloadAmountCents: bigint;
  autoReloadPaymentMethodId: string | null;
  lastAutoReloadAt: Date | null;
  lowBalanceThresholdCents: bigint;
  assistantSpendCapCents: bigint | null;
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
    assistantSpendCapCents:
      row.assistantSpendCapCents === null
        ? null
        : Number(row.assistantSpendCapCents),
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
 *
 * `opts.system` routes the read/upsert through {@link withSystemDb} instead of
 * {@link withTenantDb}. Request paths always run inside a tenant scope and must
 * leave this false so RLS stays load-bearing; only trusted cross-tenant crons
 * that sweep every org with no active scope (e.g. billing.dunning-sweep) pass
 * `system: true`, mirroring sweepDunning()'s own withSystemDb usage.
 */
export async function getOrgBillingSettings(
  orgId: string,
  opts?: { system?: boolean },
): Promise<OrgBillingSettings> {
  const start = Date.now();

  const runner = opts?.system ? withSystemDb : withTenantDb;
  const row = await runner(async (tx) => {
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
        assistantSpendCapCents: BigInt(DEFAULT_ASSISTANT_SPEND_CAP_CENTS),
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
    throw new Error(
      `billing-settings: failed to resolve settings for org ${orgId}`,
    );
  }

  logger.debug(
    { orgId, durationMs: Date.now() - start },
    "billing: org billing settings resolved",
  );

  return rowToSettings(row);
}

// ── readOrgBillingSettings ────────────────────────────────────────────────────

/**
 * The org's GAU billing settings: a SELECT, never an INSERT.
 *
 * An org with no `org_billing_settings` row answers with the column defaults.
 * The gate, the recorder and `get_gau_bucket` read through this, so none of
 * them creates a row; the row appears on the first write that needs it
 * (`set_auto_topup`, `set_org_billing_terms`, `ensureStripeCustomer`).
 * Runs inside the caller's tenant scope; `opts.system` routes it through
 * `withSystemDb` for the callers with none — the close job and the
 * platform-operator handler — the switch `getOrgBillingSettings` carries.
 */
export async function readOrgBillingSettings(
  orgId: string,
  opts?: { system?: boolean },
): Promise<OrgGauBillingSettings> {
  const runner = opts?.system ? withSystemDb : withTenantDb;
  const row = await runner((tx) =>
    tx.query.orgBillingSettings.findFirst({
      where: eq(schema.orgBillingSettings.orgId, orgId),
      columns: {
        stripeCustomerId: true,
        approvedForInvoiceBilling: true,
        invoiceGauMax: true,
        autoTopupEnabled: true,
        autoTopupBlocks: true,
        dunningState: true,
      },
    }),
  );
  if (!row) return { orgId, ...GAU_SETTINGS_DEFAULTS };
  return {
    orgId,
    stripeCustomerId: row.stripeCustomerId,
    approvedForInvoiceBilling: row.approvedForInvoiceBilling,
    invoiceGauMax: Number(row.invoiceGauMax),
    autoTopupEnabled: row.autoTopupEnabled,
    autoTopupBlocks: Number(row.autoTopupBlocks),
    dunningState: row.dunningState as OrgGauBillingSettings["dunningState"],
  };
}

// ── setAutoTopup ──────────────────────────────────────────────────────────────

/** The two auto-top-up columns, as the customer sets and reads them. */
export interface AutoTopupSettings {
  /** Charge the saved card when the GAU bucket runs out. */
  enabled: boolean;
  /** Blocks bought per top-up; the column's CHECK is `> 0`. */
  blocks: number;
}

/**
 * Write the org's auto-top-up preference and return it as stored (ADR-055 §5,
 * `set_auto_topup`).
 *
 * An upsert keyed on `org_id`, so an org whose settings row does not exist yet
 * — every org that has not bought anything, which is most of the orgs that
 * come here — gets one, and an org that has a row keeps every other column on
 * it. Runs inside the caller's tenant scope: the capability is scoped, and RLS
 * is the tenant fence.
 *
 * Accepted in either billing mode and with or without a saved card. The
 * columns exist on every org; the recorder reads them only in prepaid, and
 * only once a card is on file.
 */
export async function setAutoTopup(
  orgId: string,
  input: AutoTopupSettings,
): Promise<AutoTopupSettings> {
  if (!Number.isInteger(input.blocks) || input.blocks < 1) {
    throw new Error("billing-settings: auto top-up blocks must be >= 1");
  }
  const row = await withTenantDb(async (tx) => {
    const [saved] = await tx
      .insert(schema.orgBillingSettings)
      .values({
        orgId,
        autoTopupEnabled: input.enabled,
        autoTopupBlocks: input.blocks,
      })
      .onConflictDoUpdate({
        target: schema.orgBillingSettings.orgId,
        set: {
          autoTopupEnabled: input.enabled,
          autoTopupBlocks: input.blocks,
          updatedAt: new Date(),
        },
      })
      .returning({
        autoTopupEnabled: schema.orgBillingSettings.autoTopupEnabled,
        autoTopupBlocks: schema.orgBillingSettings.autoTopupBlocks,
      });
    return saved ?? null;
  });
  if (!row) {
    throw new Error(
      `billing-settings: failed to save auto top-up for org ${orgId}`,
    );
  }
  logger.info(
    { orgId, enabled: row.autoTopupEnabled, blocks: row.autoTopupBlocks },
    "billing: auto top-up settings updated",
  );
  return { enabled: row.autoTopupEnabled, blocks: Number(row.autoTopupBlocks) };
}

// ── setOrgBillingTerms ────────────────────────────────────────────────────────

/** The two columns only a platform operator sets (ADR-055 §5). */
export interface OrgBillingTerms {
  orgId: string;
  /** true → invoice billing; false → prepaid. */
  approvedForInvoiceBilling: boolean;
  /** Uninvoiced-overage ceiling; read only while invoice billing is on. */
  invoiceGauMax: number;
}

/**
 * Write one org's commercial billing terms and return the stored row
 * (`set_org_billing_terms`).
 *
 * Runs on {@link withSystemDb}: the capability is unscoped and the call
 * carries no tenant, so there is no scope for RLS to read. The row is keyed on
 * the caller-supplied `orgId`, which the contract constrains to a uuid and the
 * operator script resolves from an org slug.
 *
 * The upsert touches only these two columns; a switch back to prepaid with
 * uninvoiced overage still open is closed by the caller (WL-31), not here.
 */
export async function setOrgBillingTerms(
  terms: OrgBillingTerms,
): Promise<OrgBillingTerms> {
  if (!Number.isInteger(terms.invoiceGauMax) || terms.invoiceGauMax < 1) {
    throw new Error("billing-settings: invoiceGauMax must be >= 1");
  }
  const row = await withSystemDb(async (tx) => {
    const [saved] = await tx
      .insert(schema.orgBillingSettings)
      .values({
        orgId: terms.orgId,
        approvedForInvoiceBilling: terms.approvedForInvoiceBilling,
        invoiceGauMax: terms.invoiceGauMax,
      })
      .onConflictDoUpdate({
        target: schema.orgBillingSettings.orgId,
        set: {
          approvedForInvoiceBilling: terms.approvedForInvoiceBilling,
          invoiceGauMax: terms.invoiceGauMax,
          updatedAt: new Date(),
        },
      })
      .returning({
        orgId: schema.orgBillingSettings.orgId,
        approvedForInvoiceBilling:
          schema.orgBillingSettings.approvedForInvoiceBilling,
        invoiceGauMax: schema.orgBillingSettings.invoiceGauMax,
      });
    return saved ?? null;
  });
  if (!row) {
    throw new Error(
      `billing-settings: failed to save billing terms for org ${terms.orgId}`,
    );
  }
  logger.info(
    {
      orgId: row.orgId,
      approvedForInvoiceBilling: row.approvedForInvoiceBilling,
      invoiceGauMax: row.invoiceGauMax,
    },
    "billing: org billing terms updated",
  );
  return {
    orgId: row.orgId,
    approvedForInvoiceBilling: row.approvedForInvoiceBilling,
    invoiceGauMax: Number(row.invoiceGauMax),
  };
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

  // Guard: enabling auto-reload requires a payment method on file or being provided.
  if (input.enabled === true) {
    const hasPaymentMethodId =
      input.paymentMethodId !== null && input.paymentMethodId !== undefined;

    // If no payment method is provided in this request, check for a default on file.
    let hasValidPaymentMethod = hasPaymentMethodId;
    if (!hasValidPaymentMethod) {
      const settings = await getOrgBillingSettings(orgId);
      // If the settings already have a payment method, that's valid.
      if (settings.autoReloadPaymentMethodId) {
        hasValidPaymentMethod = true;
      } else {
        // Check if the org has a default payment method on Stripe.
        try {
          const customerId = await readRecordedCustomerId(orgId);
          if (customerId) {
            const defaultPm =
              await billingProvider().getDefaultPaymentMethodId(customerId);
            hasValidPaymentMethod = !!defaultPm;
          }
        } catch (err) {
          logger.warn(
            { orgId, err },
            "billing-settings: could not check for default payment method",
          );
        }
      }
    }

    if (!hasValidPaymentMethod) {
      throw new Error(
        "billing-settings: cannot enable auto-reload without a saved payment method",
      );
    }
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

// ── updateAssistantSpendCap ───────────────────────────────────────────────────

/**
 * Set the organisation's monthly cap on platform-paid assistant tokens
 * (ADR-053 §3). `null` removes the cap, which is an explicit operator choice;
 * a number is credit cents per calendar month and must be non-negative — zero
 * refuses every platform-paid assistant turn, which is how an organisation
 * that has not yet brought its own key opts out of the assistant entirely.
 *
 * Ensures the settings row exists first (via getOrgBillingSettings) so the
 * update always has a base row.
 */
export async function updateAssistantSpendCap(
  orgId: string,
  capCents: number | null,
): Promise<OrgBillingSettings> {
  if (capCents !== null && (!Number.isInteger(capCents) || capCents < 0)) {
    throw new Error(
      "assistantSpendCapCents must be a non-negative integer or null",
    );
  }
  await getOrgBillingSettings(orgId);
  const row = await withTenantDb(async (tx) => {
    const [updated] = await tx
      .update(schema.orgBillingSettings)
      .set({
        assistantSpendCapCents: capCents === null ? null : BigInt(capCents),
        updatedAt: new Date(),
      })
      .where(eq(schema.orgBillingSettings.orgId, orgId))
      .returning();
    return updated ?? null;
  });
  if (!row) {
    throw new Error(
      `billing-settings: failed to update the assistant spend cap for org ${orgId}`,
    );
  }
  logger.info(
    { orgId, assistantSpendCapCents: capCents },
    "billing: assistant spend cap updated",
  );
  return rowToSettings(row);
}

// ── The assistant spend cap on a system transaction ───────────────────────────

/** A valid cap: a non-negative whole number of credit cents, or null for none. */
function assertAssistantSpendCap(capCents: number | null): void {
  if (capCents !== null && (!Number.isSafeInteger(capCents) || capCents < 0)) {
    throw new Error(
      "assistantSpendCapCents must be a non-negative integer or null",
    );
  }
}

/**
 * The org's monthly cap on platform-paid assistant tokens, read on the
 * caller's executor: the stored value, or the column default
 * ({@link DEFAULT_ASSISTANT_SPEND_CAP_CENTS}) for an org with no settings row.
 * Null means no cap. Never inserts.
 */
export async function readAssistantSpendCapOn(
  tx: Tx,
  orgId: string,
): Promise<number | null> {
  const rows = await tx
    .select({ capCents: schema.orgBillingSettings.assistantSpendCapCents })
    .from(schema.orgBillingSettings)
    .where(eq(schema.orgBillingSettings.orgId, orgId))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_ASSISTANT_SPEND_CAP_CENTS;
  return row.capCents === null ? null : Number(row.capCents);
}

/**
 * {@link readAssistantSpendCapOn} for a caller with no tenant: the operator
 * scripts, which read the cap to warn before an order's credits outrun it.
 */
export async function readAssistantSpendCap(
  orgId: string,
): Promise<number | null> {
  // tenancy: platform-operator read with no tenant scope, filtered by orgId, the
  // organisation the operator named; the settings row is keyed on it.
  return withSystemDb((tx) => readAssistantSpendCapOn(tx, orgId));
}

/**
 * Write the org's assistant spend cap on the caller's executor and return the
 * stored value. An upsert keyed on `org_id`, so an org with no settings row
 * gets one with every other column at its default. Used by the platform
 * operator's two paths to the cap: `set_org_billing_terms` and the credits
 * grant of a prepaid order that carries a cap (prepaid-orders.ts).
 */
export async function writeAssistantSpendCapOn(
  tx: Tx,
  orgId: string,
  capCents: number | null,
): Promise<number | null> {
  assertAssistantSpendCap(capCents);
  const value = capCents === null ? null : BigInt(capCents);
  const [saved] = await tx
    .insert(schema.orgBillingSettings)
    .values({ orgId, assistantSpendCapCents: value })
    .onConflictDoUpdate({
      target: schema.orgBillingSettings.orgId,
      set: { assistantSpendCapCents: value, updatedAt: new Date() },
    })
    .returning({ capCents: schema.orgBillingSettings.assistantSpendCapCents });
  if (!saved) {
    throw new Error(
      `billing-settings: failed to save the assistant spend cap for org ${orgId}`,
    );
  }
  logger.info(
    { orgId, assistantSpendCapCents: capCents },
    "billing: assistant spend cap set by a platform operator",
  );
  return saved.capCents === null ? null : Number(saved.capCents);
}

/**
 * {@link writeAssistantSpendCapOn} for `set_org_billing_terms`, which carries
 * no tenant.
 */
export async function setAssistantSpendCap(
  orgId: string,
  capCents: number | null,
): Promise<number | null> {
  // tenancy: platform-operator write with no tenant scope, keyed on orgId from the
  // capability input; platformOnly means the kernel verified the operator binding.
  return withSystemDb((tx) => writeAssistantSpendCapOn(tx, orgId, capCents));
}
