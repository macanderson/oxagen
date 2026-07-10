/**
 * reseller.ts — reseller-revenue domain logic (config side): customer accounts,
 * price plans, attribution rules, and the per-org Stripe connection. The re-bill
 * preview/push orchestration lives in reseller-rebill.ts.
 *
 * Every function runs inside withTenantDb — org-only RLS is load-bearing — and
 * additionally filters by ctx.orgId (belt-and-suspenders, matching the rest of
 * billing). Ids crossing the boundary are public ids; internal uuids never leave.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type {
  ResellerAttributionRule,
  ResellerCustomer,
  ResellerPricePlan,
} from "@oxagen/oxagen/contracts/reseller-shared";
import type { PricePlanRate } from "./reseller-pricing";
import { encryptResellerSecret, secretLast4 } from "./reseller-secret";

const {
  resellerCustomers,
  resellerPricePlans,
  resellerAttributionRules,
  resellerSettings,
} = schema;

/** The tenant + actor a reseller mutation runs under. */
export interface ResellerCtx {
  orgId: string;
  userId: string | null;
}

/**
 * Assert a returned/selected row exists. Drizzle `.returning()` on an insert or a
 * scoped update always yields exactly one row, but the destructured element is
 * typed `T | undefined` under noUncheckedIndexedAccess — this narrows it and
 * turns a genuinely impossible empty result into a loud error, not a crash.
 */
export function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(
      `[reseller] expected a row for ${what} but the query returned none`,
    );
  }
  return row;
}

// ── Row types (internal) ─────────────────────────────────────────────────────

type CustomerRow = typeof resellerCustomers.$inferSelect;
type PricePlanRow = typeof resellerPricePlans.$inferSelect;
type AttributionRuleRow = typeof resellerAttributionRules.$inferSelect;

/** A price plan resolved for a customer: its public id, display name, currency, and rate. */
export interface ResolvedPlan {
  internalId: string;
  publicId: string;
  name: string;
  currency: string;
  rate: PricePlanRate;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function toPricePlanRate(
  row: Pick<PricePlanRow, "pricingMode" | "markupBps" | "unitPriceCents">,
): PricePlanRate {
  return {
    pricingMode: row.pricingMode === "per_unit" ? "per_unit" : "markup",
    markupBps: row.markupBps ?? null,
    unitPriceCents: row.unitPriceCents ?? null,
  };
}

function mapPricePlan(row: PricePlanRow): ResellerPricePlan {
  return {
    id: row.publicId,
    name: row.name,
    pricingMode: row.pricingMode === "per_unit" ? "per_unit" : "markup",
    markupBps: row.markupBps ?? null,
    unitPriceCents: row.unitPriceCents ?? null,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCustomer(
  row: CustomerRow,
  plansByInternalId: Map<string, ResolvedPlan>,
): ResellerCustomer {
  const plan = row.pricePlanId
    ? (plansByInternalId.get(row.pricePlanId) ?? null)
    : null;
  return {
    id: row.publicId,
    name: row.name,
    externalRef: row.externalRef ?? null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    pricePlanId: plan?.publicId ?? null,
    pricePlanName: plan?.name ?? null,
    status: row.status === "paused" ? "paused" : "active",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Shared loaders (also used by reseller-rebill.ts) ─────────────────────────

/** All live price plans for the org, keyed by internal id — used to resolve customer plans. */
export async function loadPlanMap(
  tx: DbTx,
  orgId: string,
): Promise<Map<string, ResolvedPlan>> {
  const rows = await tx
    .select()
    .from(resellerPricePlans)
    .where(
      and(
        eq(resellerPricePlans.orgId, orgId),
        isNull(resellerPricePlans.deletedAt),
      ),
    );
  const map = new Map<string, ResolvedPlan>();
  for (const r of rows) {
    map.set(r.id, {
      internalId: r.id,
      publicId: r.publicId,
      name: r.name,
      currency: r.currency,
      rate: toPricePlanRate(r),
    });
  }
  return map;
}

/** Resolve a customer public id → its row, scoped to the org and not archived. */
export async function findCustomerByPublicId(
  tx: DbTx,
  orgId: string,
  publicId: string,
): Promise<CustomerRow | null> {
  const rows = await tx
    .select()
    .from(resellerCustomers)
    .where(
      and(
        eq(resellerCustomers.orgId, orgId),
        eq(resellerCustomers.publicId, publicId),
        isNull(resellerCustomers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The Drizzle transaction handle threaded through withTenantDb. */
type DbTx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

// ── Customers ────────────────────────────────────────────────────────────────

export async function createResellerCustomer(
  ctx: ResellerCtx,
  input: {
    name: string;
    externalRef?: string | null;
    pricePlanId?: string | null;
  },
): Promise<ResellerCustomer> {
  return withTenantDb(async (tx) => {
    const plansByInternalId = await loadPlanMap(tx, ctx.orgId);
    const planInternalId = resolvePlanInternalId(
      plansByInternalId,
      input.pricePlanId ?? null,
    );
    const [row] = await tx
      .insert(resellerCustomers)
      .values({
        orgId: ctx.orgId,
        name: input.name,
        externalRef: input.externalRef ?? null,
        pricePlanId: planInternalId,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();
    return mapCustomer(
      requireRow(row, "reseller customer write"),
      plansByInternalId,
    );
  });
}

export async function listResellerCustomers(
  ctx: ResellerCtx,
  input: { status?: "active" | "paused" },
): Promise<ResellerCustomer[]> {
  return withTenantDb(async (tx) => {
    const plansByInternalId = await loadPlanMap(tx, ctx.orgId);
    const where = input.status
      ? and(
          eq(resellerCustomers.orgId, ctx.orgId),
          isNull(resellerCustomers.deletedAt),
          eq(resellerCustomers.status, input.status),
        )
      : and(
          eq(resellerCustomers.orgId, ctx.orgId),
          isNull(resellerCustomers.deletedAt),
        );
    const rows = await tx
      .select()
      .from(resellerCustomers)
      .where(where)
      .orderBy(desc(resellerCustomers.createdAt));
    return rows.map((r) => mapCustomer(r, plansByInternalId));
  });
}

export async function updateResellerCustomer(
  ctx: ResellerCtx,
  input: {
    id: string;
    name?: string;
    externalRef?: string | null;
    pricePlanId?: string | null;
    status?: "active" | "paused";
  },
): Promise<ResellerCustomer> {
  return withTenantDb(async (tx) => {
    const existing = await findCustomerByPublicId(tx, ctx.orgId, input.id);
    if (!existing) throw new Error(`Reseller customer not found: ${input.id}`);
    const plansByInternalId = await loadPlanMap(tx, ctx.orgId);

    const patch: Partial<typeof resellerCustomers.$inferInsert> = {
      updatedByUserId: ctx.userId,
      updatedAt: new Date(),
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.externalRef !== undefined) patch.externalRef = input.externalRef;
    if (input.status !== undefined) patch.status = input.status;
    if (input.pricePlanId !== undefined) {
      patch.pricePlanId = resolvePlanInternalId(
        plansByInternalId,
        input.pricePlanId,
      );
    }

    const [row] = await tx
      .update(resellerCustomers)
      .set(patch)
      .where(
        and(
          eq(resellerCustomers.id, existing.id),
          eq(resellerCustomers.orgId, ctx.orgId),
        ),
      )
      .returning();
    return mapCustomer(
      requireRow(row, "reseller customer write"),
      plansByInternalId,
    );
  });
}

export async function archiveResellerCustomer(
  ctx: ResellerCtx,
  input: { id: string },
): Promise<{ id: string; archived: true }> {
  return withTenantDb(async (tx) => {
    const existing = await findCustomerByPublicId(tx, ctx.orgId, input.id);
    if (!existing) throw new Error(`Reseller customer not found: ${input.id}`);
    await tx
      .update(resellerCustomers)
      .set({ deletedAt: new Date(), deletedByUserId: ctx.userId })
      .where(
        and(
          eq(resellerCustomers.id, existing.id),
          eq(resellerCustomers.orgId, ctx.orgId),
        ),
      );
    return { id: input.id, archived: true };
  });
}

/** Map a plan public id to its internal id, or null when absent. Throws on unknown id. */
function resolvePlanInternalId(
  plansByInternalId: Map<string, ResolvedPlan>,
  publicId: string | null,
): string | null {
  if (!publicId) return null;
  for (const plan of plansByInternalId.values()) {
    if (plan.publicId === publicId) return plan.internalId;
  }
  throw new Error(`Reseller price plan not found: ${publicId}`);
}

// ── Price plans ──────────────────────────────────────────────────────────────

export async function createResellerPricePlan(
  ctx: ResellerCtx,
  input: {
    name: string;
    pricingMode: "markup" | "per_unit";
    markupBps?: number | null;
    unitPriceCents?: number | null;
    currency: string;
  },
): Promise<ResellerPricePlan> {
  return withTenantDb(async (tx) => {
    const [row] = await tx
      .insert(resellerPricePlans)
      .values({
        orgId: ctx.orgId,
        name: input.name,
        pricingMode: input.pricingMode,
        markupBps:
          input.pricingMode === "markup" ? (input.markupBps ?? 0) : null,
        unitPriceCents:
          input.pricingMode === "per_unit" ? (input.unitPriceCents ?? 0) : null,
        currency: input.currency,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();
    return mapPricePlan(requireRow(row, "reseller price plan write"));
  });
}

export async function listResellerPricePlans(
  ctx: ResellerCtx,
): Promise<ResellerPricePlan[]> {
  return withTenantDb(async (tx) => {
    const rows = await tx
      .select()
      .from(resellerPricePlans)
      .where(
        and(
          eq(resellerPricePlans.orgId, ctx.orgId),
          isNull(resellerPricePlans.deletedAt),
        ),
      )
      .orderBy(desc(resellerPricePlans.createdAt));
    return rows.map(mapPricePlan);
  });
}

export async function updateResellerPricePlan(
  ctx: ResellerCtx,
  input: {
    id: string;
    name?: string;
    pricingMode?: "markup" | "per_unit";
    markupBps?: number | null;
    unitPriceCents?: number | null;
    currency?: string;
  },
): Promise<ResellerPricePlan> {
  return withTenantDb(async (tx) => {
    const existing = await tx
      .select()
      .from(resellerPricePlans)
      .where(
        and(
          eq(resellerPricePlans.orgId, ctx.orgId),
          eq(resellerPricePlans.publicId, input.id),
          isNull(resellerPricePlans.deletedAt),
        ),
      )
      .limit(1);
    const current = existing[0];
    if (!current) throw new Error(`Reseller price plan not found: ${input.id}`);

    const nextMode =
      input.pricingMode ??
      (current.pricingMode === "per_unit" ? "per_unit" : "markup");
    const nextMarkup =
      input.markupBps !== undefined ? input.markupBps : current.markupBps;
    const nextUnit =
      input.unitPriceCents !== undefined
        ? input.unitPriceCents
        : current.unitPriceCents;
    // Enforce the same mode↔rate invariant the create contract refines.
    if (nextMode === "markup" && nextMarkup == null) {
      throw new Error("markup plans require markupBps");
    }
    if (nextMode === "per_unit" && nextUnit == null) {
      throw new Error("per_unit plans require unitPriceCents");
    }

    const [row] = await tx
      .update(resellerPricePlans)
      .set({
        name: input.name ?? current.name,
        pricingMode: nextMode,
        // Null out the rate that does not belong to the (possibly new) mode.
        markupBps: nextMode === "markup" ? nextMarkup : null,
        unitPriceCents: nextMode === "per_unit" ? nextUnit : null,
        currency: input.currency ?? current.currency,
        updatedByUserId: ctx.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resellerPricePlans.id, current.id),
          eq(resellerPricePlans.orgId, ctx.orgId),
        ),
      )
      .returning();
    return mapPricePlan(requireRow(row, "reseller price plan write"));
  });
}

// ── Attribution rules ────────────────────────────────────────────────────────

function mapAttributionRule(
  row: AttributionRuleRow,
  customerPublicId: string,
  customerName: string,
): ResellerAttributionRule {
  return {
    id: row.publicId,
    matchKind:
      row.matchKind === "principal"
        ? "principal"
        : row.matchKind === "capability"
          ? "capability"
          : "workspace",
    matchValue: row.matchValue,
    matchLabel: row.matchLabel,
    customerId: customerPublicId,
    customerName,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveResellerAttributionRule(
  ctx: ResellerCtx,
  input: {
    id?: string;
    matchKind: "workspace" | "principal" | "capability";
    matchValue: string;
    matchLabel: string;
    customerId: string;
    priority: number;
  },
): Promise<ResellerAttributionRule> {
  return withTenantDb(async (tx) => {
    const customer = await findCustomerByPublicId(
      tx,
      ctx.orgId,
      input.customerId,
    );
    if (!customer)
      throw new Error(`Reseller customer not found: ${input.customerId}`);

    if (input.id) {
      const existing = await tx
        .select()
        .from(resellerAttributionRules)
        .where(
          and(
            eq(resellerAttributionRules.orgId, ctx.orgId),
            eq(resellerAttributionRules.publicId, input.id),
            isNull(resellerAttributionRules.deletedAt),
          ),
        )
        .limit(1);
      const current = existing[0];
      if (!current)
        throw new Error(`Reseller attribution rule not found: ${input.id}`);
      const [row] = await tx
        .update(resellerAttributionRules)
        .set({
          matchKind: input.matchKind,
          matchValue: input.matchValue,
          matchLabel: input.matchLabel,
          customerId: customer.id,
          priority: input.priority,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resellerAttributionRules.id, current.id),
            eq(resellerAttributionRules.orgId, ctx.orgId),
          ),
        )
        .returning();
      return mapAttributionRule(
        requireRow(row, "reseller attribution rule write"),
        input.customerId,
        customer.name,
      );
    }

    const [row] = await tx
      .insert(resellerAttributionRules)
      .values({
        orgId: ctx.orgId,
        matchKind: input.matchKind,
        matchValue: input.matchValue,
        matchLabel: input.matchLabel,
        customerId: customer.id,
        priority: input.priority,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();
    return mapAttributionRule(
      requireRow(row, "reseller attribution rule write"),
      input.customerId,
      customer.name,
    );
  });
}

export async function listResellerAttributionRules(
  ctx: ResellerCtx,
  input: { customerId?: string },
): Promise<ResellerAttributionRule[]> {
  return withTenantDb(async (tx) => {
    // Resolve customers up front so each rule cites a name, never a raw id.
    const customers = await tx
      .select()
      .from(resellerCustomers)
      .where(
        and(
          eq(resellerCustomers.orgId, ctx.orgId),
          isNull(resellerCustomers.deletedAt),
        ),
      );
    const byInternalId = new Map(customers.map((c) => [c.id, c]));

    const filterCustomer = input.customerId
      ? byInternalId.get(
          [...byInternalId.values()].find(
            (c) => c.publicId === input.customerId,
          )?.id ?? "",
        )
      : undefined;

    const where =
      input.customerId && filterCustomer
        ? and(
            eq(resellerAttributionRules.orgId, ctx.orgId),
            isNull(resellerAttributionRules.deletedAt),
            eq(resellerAttributionRules.customerId, filterCustomer.id),
          )
        : and(
            eq(resellerAttributionRules.orgId, ctx.orgId),
            isNull(resellerAttributionRules.deletedAt),
          );

    const rows = await tx
      .select()
      .from(resellerAttributionRules)
      .where(where)
      .orderBy(resellerAttributionRules.priority);

    return rows.map((r) => {
      const customer = byInternalId.get(r.customerId);
      return mapAttributionRule(
        r,
        customer?.publicId ?? "",
        customer?.name ?? "unknown customer",
      );
    });
  });
}

export async function deleteResellerAttributionRule(
  ctx: ResellerCtx,
  input: { id: string },
): Promise<{ id: string; deleted: true }> {
  return withTenantDb(async (tx) => {
    const existing = await tx
      .select()
      .from(resellerAttributionRules)
      .where(
        and(
          eq(resellerAttributionRules.orgId, ctx.orgId),
          eq(resellerAttributionRules.publicId, input.id),
          isNull(resellerAttributionRules.deletedAt),
        ),
      )
      .limit(1);
    const current = existing[0];
    if (!current)
      throw new Error(`Reseller attribution rule not found: ${input.id}`);
    await tx
      .update(resellerAttributionRules)
      .set({ deletedAt: new Date(), deletedByUserId: ctx.userId })
      .where(
        and(
          eq(resellerAttributionRules.id, current.id),
          eq(resellerAttributionRules.orgId, ctx.orgId),
        ),
      );
    return { id: input.id, deleted: true };
  });
}

// ── Stripe connection (per-org reseller key) ─────────────────────────────────

export async function configureResellerStripe(
  ctx: ResellerCtx,
  input: { secretKey: string; accountLabel?: string | null },
): Promise<{ connected: true; accountLabel: string | null; keyLast4: string }> {
  const { ciphertext, keyId } = await encryptResellerSecret(input.secretKey);
  const last4 = secretLast4(input.secretKey);
  const label = input.accountLabel ?? null;

  return withTenantDb(async (tx) => {
    const existing = await tx
      .select()
      .from(resellerSettings)
      .where(eq(resellerSettings.orgId, ctx.orgId))
      .limit(1);
    if (existing[0]) {
      await tx
        .update(resellerSettings)
        .set({
          stripeSecretCiphertext: ciphertext,
          stripeSecretKeyId: keyId,
          stripeSecretLast4: last4,
          stripeAccountLabel: label,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        })
        .where(eq(resellerSettings.orgId, ctx.orgId));
    } else {
      await tx.insert(resellerSettings).values({
        orgId: ctx.orgId,
        stripeSecretCiphertext: ciphertext,
        stripeSecretKeyId: keyId,
        stripeSecretLast4: last4,
        stripeAccountLabel: label,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      });
    }
    return { connected: true, accountLabel: label, keyLast4: last4 };
  });
}

export async function getResellerStripeStatus(ctx: ResellerCtx): Promise<{
  connected: boolean;
  accountLabel: string | null;
  keyLast4: string | null;
  updatedAt: string | null;
}> {
  return withTenantDb(async (tx) => {
    const rows = await tx
      .select()
      .from(resellerSettings)
      .where(eq(resellerSettings.orgId, ctx.orgId))
      .limit(1);
    const row = rows[0];
    const connected = Boolean(row?.stripeSecretCiphertext);
    return {
      connected,
      accountLabel: row?.stripeAccountLabel ?? null,
      keyLast4: connected ? (row?.stripeSecretLast4 ?? null) : null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });
}
