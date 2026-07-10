/**
 * reseller-rebill.ts — the re-bill orchestration: attribute a period's usage to
 * customers, price it, preview it, and push it to the reseller's Stripe account.
 *
 * Transaction discipline: usage (ClickHouse) and the Stripe push are external
 * calls, so they run OUTSIDE withTenantDb — each DB touch is its own short
 * transaction (load config, snapshot the run, record the result). Never a Stripe
 * call held inside an open tenant transaction.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { readResellerUsageAttribution } from "@oxagen/telemetry";
import type {
  ResellerRebillLineItem,
  ResellerRebillPreview,
  ResellerRebillRun,
  ResellerMatchKind,
} from "@oxagen/oxagen/contracts/reseller-shared";
import {
  findCustomerByPublicId,
  loadPlanMap,
  requireRow,
  type ResellerCtx,
  type ResolvedPlan,
} from "./reseller";
import {
  matchRuleForSlice,
  microsToCents,
  priceAttributedUsage,
  type AttributionRuleMatch,
} from "./reseller-pricing";
import { decryptResellerSecret } from "./reseller-secret";
import { resellerBillingProvider } from "./client";

const {
  resellerCustomers,
  resellerAttributionRules,
  resellerRebillRuns,
  resellerRebillLineItems,
  resellerSettings,
} = schema;

type DbTx = Parameters<Parameters<typeof withTenantDb>[0]>[0];
type CustomerRow = typeof resellerCustomers.$inferSelect;
type RunRow = typeof resellerRebillRuns.$inferSelect;
type LineItemRow = typeof resellerRebillLineItems.$inferSelect;

/** An attribution rule carrying its display label (the matcher ignores the label). */
interface RuleWithLabel extends AttributionRuleMatch {
  matchLabel: string;
}

function toMatchKind(raw: string): ResellerMatchKind {
  return raw === "principal"
    ? "principal"
    : raw === "capability"
      ? "capability"
      : "workspace";
}

/** Load the org's live attribution rules keyed to internal customer ids. */
async function loadRules(tx: DbTx, orgId: string): Promise<RuleWithLabel[]> {
  const rows = await tx
    .select()
    .from(resellerAttributionRules)
    .where(
      and(
        eq(resellerAttributionRules.orgId, orgId),
        isNull(resellerAttributionRules.deletedAt),
      ),
    )
    .orderBy(resellerAttributionRules.priority);
  return rows.map((r) => ({
    customerId: r.customerId,
    matchKind: toMatchKind(r.matchKind),
    matchValue: r.matchValue,
    matchLabel: r.matchLabel,
    priority: r.priority,
  }));
}

interface AccumulatedLine {
  label: string;
  matchKind: ResellerMatchKind;
  costMicros: number;
  executions: number;
}

/**
 * Attribute the disjoint usage slices to the target customers via the rules,
 * then price each customer's aggregated lines under its plan. Pure over its
 * inputs (no I/O) so preview and push share one, testable, attribution+pricing path.
 */
function buildPreviews(
  targetCustomers: readonly CustomerRow[],
  plansByInternalId: Map<string, ResolvedPlan>,
  rules: readonly RuleWithLabel[],
  slices: Awaited<ReturnType<typeof readResellerUsageAttribution>>,
): { previews: ResellerRebillPreview[]; unattributedCostCents: number } {
  const targetIds = new Set(targetCustomers.map((c) => c.id));
  const perCustomer = new Map<string, Map<string, AccumulatedLine>>();
  let unattributedMicros = 0;

  for (const slice of slices) {
    const rule = matchRuleForSlice(
      {
        workspaceId: slice.workspaceId,
        principalId: slice.principalId,
        capabilityName: slice.capabilityName,
      },
      rules,
    );
    if (!rule) {
      unattributedMicros += slice.costMicros;
      continue;
    }
    // Matched a rule for a customer not in scope (paused/other) — attributed
    // elsewhere, so neither this customer's line nor the unattributed bucket.
    if (!targetIds.has(rule.customerId)) continue;

    let lines = perCustomer.get(rule.customerId);
    if (!lines) {
      lines = new Map();
      perCustomer.set(rule.customerId, lines);
    }
    const lineKey = `${rule.matchKind}:${rule.matchValue}`;
    let acc = lines.get(lineKey);
    if (!acc) {
      acc = {
        label: rule.matchLabel,
        matchKind: rule.matchKind,
        costMicros: 0,
        executions: 0,
      };
      lines.set(lineKey, acc);
    }
    acc.costMicros += slice.costMicros;
    acc.executions += slice.executions;
  }

  const previews: ResellerRebillPreview[] = targetCustomers.map((customer) => {
    const plan = customer.pricePlanId
      ? (plansByInternalId.get(customer.pricePlanId) ?? null)
      : null;
    const lineMap =
      perCustomer.get(customer.id) ?? new Map<string, AccumulatedLine>();

    const lineItems: ResellerRebillLineItem[] = [];
    let subtotalCents = 0;
    let totalCents = 0;
    for (const acc of lineMap.values()) {
      const rawCostCents = microsToCents(acc.costMicros);
      const amountCents = priceAttributedUsage(
        rawCostCents,
        acc.executions,
        plan?.rate ?? null,
      );
      subtotalCents += rawCostCents;
      totalCents += amountCents;
      lineItems.push({
        label: acc.label,
        matchKind: acc.matchKind,
        rawCostCents,
        quantity: acc.executions,
        unitPriceCents:
          plan?.rate.pricingMode === "per_unit"
            ? plan.rate.unitPriceCents
            : null,
        amountCents,
      });
    }
    lineItems.sort((a, b) => b.amountCents - a.amountCents);

    return {
      customerId: customer.publicId,
      customerName: customer.name,
      pricePlanId: plan?.publicId ?? null,
      pricePlanName: plan?.name ?? null,
      currency: plan?.currency ?? "usd",
      subtotalCents,
      totalCents,
      lineItems,
    };
  });

  return { previews, unattributedCostCents: microsToCents(unattributedMicros) };
}

// ── Preview ──────────────────────────────────────────────────────────────────

export async function previewResellerRebill(
  ctx: ResellerCtx,
  input: { start: string; end: string; customerId?: string },
): Promise<{
  range: { start: string; end: string };
  previews: ResellerRebillPreview[];
  unattributedCostCents: number;
}> {
  const startD = new Date(input.start);
  const endD = new Date(input.end);

  const { customers, plansByInternalId, rules } = await withTenantDb(
    async (tx) => {
      const plansByInternalId = await loadPlanMap(tx, ctx.orgId);
      const rules = await loadRules(tx, ctx.orgId);
      let customers: CustomerRow[];
      if (input.customerId) {
        const c = await findCustomerByPublicId(tx, ctx.orgId, input.customerId);
        customers = c ? [c] : [];
      } else {
        customers = await tx
          .select()
          .from(resellerCustomers)
          .where(
            and(
              eq(resellerCustomers.orgId, ctx.orgId),
              isNull(resellerCustomers.deletedAt),
              eq(resellerCustomers.status, "active"),
            ),
          );
      }
      return { customers, plansByInternalId, rules };
    },
  );

  // Usage lives in ClickHouse — read it outside the tenant transaction.
  const slices = await readResellerUsageAttribution({
    orgId: ctx.orgId,
    start: startD,
    end: endD,
  });
  const { previews, unattributedCostCents } = buildPreviews(
    customers,
    plansByInternalId,
    rules,
    slices,
  );

  return {
    range: { start: input.start, end: input.end },
    previews,
    unattributedCostCents,
  };
}

// ── Run mapping ──────────────────────────────────────────────────────────────

function mapLineItemRow(row: LineItemRow): ResellerRebillLineItem {
  return {
    label: row.label,
    matchKind: row.matchKind ? toMatchKind(row.matchKind) : null,
    rawCostCents: row.rawCostCents,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents ?? null,
    amountCents: row.amountCents,
  };
}

function mapRun(
  row: RunRow,
  customerPublicId: string,
  customerName: string,
  lineItems: ResellerRebillLineItem[],
): ResellerRebillRun {
  return {
    id: row.publicId,
    customerId: customerPublicId,
    customerName,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    currency: row.currency,
    subtotalCents: row.subtotalCents,
    totalCents: row.totalCents,
    providerInvoiceId: row.providerInvoiceId ?? null,
    hostedInvoiceUrl: row.hostedInvoiceUrl ?? null,
    status:
      row.status === "pushed"
        ? "pushed"
        : row.status === "failed"
          ? "failed"
          : "pending",
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lineItems,
  };
}

/** Upsert the (customer, period) run to pending and replace its line-item snapshot. */
async function upsertRun(
  tx: DbTx,
  ctx: ResellerCtx,
  customerInternalId: string,
  periodStart: Date,
  periodEnd: Date,
  preview: ResellerRebillPreview,
  existingRunId: string | null,
): Promise<RunRow> {
  let run: RunRow;
  if (existingRunId) {
    const [row] = await tx
      .update(resellerRebillRuns)
      .set({
        currency: preview.currency,
        subtotalCents: preview.subtotalCents,
        totalCents: preview.totalCents,
        status: "pending",
        error: null,
        updatedByUserId: ctx.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resellerRebillRuns.id, existingRunId),
          eq(resellerRebillRuns.orgId, ctx.orgId),
        ),
      )
      .returning();
    run = requireRow(row, "rebill run upsert");
    await tx
      .delete(resellerRebillLineItems)
      .where(eq(resellerRebillLineItems.runId, existingRunId));
  } else {
    const [row] = await tx
      .insert(resellerRebillRuns)
      .values({
        orgId: ctx.orgId,
        customerId: customerInternalId,
        periodStart,
        periodEnd,
        currency: preview.currency,
        subtotalCents: preview.subtotalCents,
        totalCents: preview.totalCents,
        status: "pending",
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();
    run = requireRow(row, "rebill run upsert");
  }

  if (preview.lineItems.length > 0) {
    await tx.insert(resellerRebillLineItems).values(
      preview.lineItems.map((li) => ({
        orgId: ctx.orgId,
        runId: run.id,
        label: li.label,
        matchKind: li.matchKind,
        rawCostCents: li.rawCostCents,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        amountCents: li.amountCents,
        createdByUserId: ctx.userId,
      })),
    );
  }
  return run;
}

/** Mark a run failed with a message (a recorded, inspectable attempt). */
async function failRun(
  tx: DbTx,
  ctx: ResellerCtx,
  runInternalId: string,
  message: string,
): Promise<RunRow> {
  const [row] = await tx
    .update(resellerRebillRuns)
    .set({
      status: "failed",
      error: message,
      updatedByUserId: ctx.userId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resellerRebillRuns.id, runInternalId),
        eq(resellerRebillRuns.orgId, ctx.orgId),
      ),
    )
    .returning();
  return requireRow(row, "rebill run fail");
}

// ── Push ─────────────────────────────────────────────────────────────────────

export async function pushResellerRebill(
  ctx: ResellerCtx,
  input: { customerId: string; start: string; end: string; finalize: boolean },
): Promise<{ run: ResellerRebillRun; needsStripeConnection: boolean }> {
  const startD = new Date(input.start);
  const endD = new Date(input.end);

  const { customer, plansByInternalId, rules, existingRun, settings } =
    await withTenantDb(async (tx) => {
      const customer = await findCustomerByPublicId(
        tx,
        ctx.orgId,
        input.customerId,
      );
      if (!customer)
        throw new Error(`Reseller customer not found: ${input.customerId}`);
      const plansByInternalId = await loadPlanMap(tx, ctx.orgId);
      const rules = await loadRules(tx, ctx.orgId);
      const existingRunRows = await tx
        .select()
        .from(resellerRebillRuns)
        .where(
          and(
            eq(resellerRebillRuns.orgId, ctx.orgId),
            eq(resellerRebillRuns.customerId, customer.id),
            eq(resellerRebillRuns.periodStart, startD),
            eq(resellerRebillRuns.periodEnd, endD),
          ),
        )
        .limit(1);
      const settingsRows = await tx
        .select()
        .from(resellerSettings)
        .where(eq(resellerSettings.orgId, ctx.orgId))
        .limit(1);
      return {
        customer,
        plansByInternalId,
        rules,
        existingRun: existingRunRows[0] ?? null,
        settings: settingsRows[0] ?? null,
      };
    });

  // Idempotency: a run already pushed to Stripe is returned as-is — a re-push
  // never creates a second invoice for the same (customer, period).
  if (
    existingRun &&
    existingRun.status === "pushed" &&
    existingRun.providerInvoiceId
  ) {
    const existingLines = await withTenantDb((tx) =>
      tx
        .select()
        .from(resellerRebillLineItems)
        .where(eq(resellerRebillLineItems.runId, existingRun.id)),
    );
    return {
      run: mapRun(
        existingRun,
        customer.publicId,
        customer.name,
        existingLines.map(mapLineItemRow),
      ),
      needsStripeConnection: false,
    };
  }

  const plan = customer.pricePlanId
    ? (plansByInternalId.get(customer.pricePlanId) ?? null)
    : null;

  // Compute the single-customer preview from usage (ClickHouse, outside a tx).
  const slices = await readResellerUsageAttribution({
    orgId: ctx.orgId,
    start: startD,
    end: endD,
  });
  const preview = requireRow(
    buildPreviews([customer], plansByInternalId, rules, slices).previews[0],
    "single-customer rebill preview",
  );

  // Snapshot the run (pending) + line items.
  const run = await withTenantDb((tx) =>
    upsertRun(
      tx,
      ctx,
      customer.id,
      startD,
      endD,
      preview,
      existingRun?.id ?? null,
    ),
  );

  const finishFailed = async (message: string, needsConnection: boolean) => {
    const failed = await withTenantDb((tx) =>
      failRun(tx, ctx, run.id, message),
    );
    return {
      run: mapRun(failed, customer.publicId, customer.name, preview.lineItems),
      needsStripeConnection: needsConnection,
    };
  };

  if (!plan)
    return finishFailed(
      "Assign a price plan to this customer before pushing.",
      false,
    );
  if (preview.lineItems.length === 0) {
    return finishFailed("No attributed usage to bill for this period.", false);
  }
  if (!settings?.stripeSecretCiphertext || !settings.stripeSecretKeyId) {
    return finishFailed("Connect your Stripe account to push invoices.", true);
  }

  // Push to the reseller's own Stripe account.
  const secret = await decryptResellerSecret(
    Buffer.from(settings.stripeSecretCiphertext),
    settings.stripeSecretKeyId,
  );
  const provider = resellerBillingProvider(secret);
  const idempotencyKey = `rebill:${ctx.orgId}:${customer.id}:${startD.toISOString()}:${endD.toISOString()}`;

  try {
    const result = await provider.createExternalInvoice({
      customerId: customer.stripeCustomerId ?? null,
      customerName: customer.name,
      customerMetadata: {
        oxagen_org_id: ctx.orgId,
        oxagen_reseller_customer: customer.publicId,
      },
      currency: preview.currency,
      lines: preview.lineItems.map((li) => ({
        description: li.label,
        amountCents: li.amountCents,
        quantity: li.quantity,
        metadata: { match_kind: li.matchKind ?? "" },
      })),
      metadata: {
        oxagen_org_id: ctx.orgId,
        oxagen_reseller_customer: customer.publicId,
        period_start: startD.toISOString(),
        period_end: endD.toISOString(),
      },
      finalize: input.finalize,
      idempotencyKey,
    });

    const pushed = await withTenantDb(async (tx) => {
      if (!customer.stripeCustomerId) {
        await tx
          .update(resellerCustomers)
          .set({
            stripeCustomerId: result.providerCustomerId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(resellerCustomers.id, customer.id),
              eq(resellerCustomers.orgId, ctx.orgId),
            ),
          );
      }
      const [row] = await tx
        .update(resellerRebillRuns)
        .set({
          status: "pushed",
          providerInvoiceId: result.invoice.providerInvoiceId,
          providerCustomerId: result.providerCustomerId,
          hostedInvoiceUrl: result.invoice.hostedInvoiceUrl,
          error: null,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resellerRebillRuns.id, run.id),
            eq(resellerRebillRuns.orgId, ctx.orgId),
          ),
        )
        .returning();
      return requireRow(row, "rebill run push");
    });

    return {
      run: mapRun(pushed, customer.publicId, customer.name, preview.lineItems),
      needsStripeConnection: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finishFailed(`Stripe push failed: ${message}`, false);
  }
}

// ── Run history ──────────────────────────────────────────────────────────────

export async function listResellerRebillRuns(
  ctx: ResellerCtx,
  input: { customerId?: string; limit: number },
): Promise<ResellerRebillRun[]> {
  return withTenantDb(async (tx) => {
    // Include archived customers so historical runs still resolve a name.
    const customers = await tx
      .select()
      .from(resellerCustomers)
      .where(eq(resellerCustomers.orgId, ctx.orgId));
    const byInternalId = new Map(customers.map((c) => [c.id, c]));
    const filterInternalId = input.customerId
      ? (customers.find((c) => c.publicId === input.customerId)?.id ?? null)
      : null;

    const where = filterInternalId
      ? and(
          eq(resellerRebillRuns.orgId, ctx.orgId),
          eq(resellerRebillRuns.customerId, filterInternalId),
        )
      : eq(resellerRebillRuns.orgId, ctx.orgId);

    const runs = await tx
      .select()
      .from(resellerRebillRuns)
      .where(where)
      .orderBy(desc(resellerRebillRuns.createdAt))
      .limit(input.limit);

    const runIds = runs.map((r) => r.id);
    const lines = runIds.length
      ? await tx
          .select()
          .from(resellerRebillLineItems)
          .where(inArray(resellerRebillLineItems.runId, runIds))
      : [];
    const linesByRun = new Map<string, LineItemRow[]>();
    for (const line of lines) {
      const arr = linesByRun.get(line.runId) ?? [];
      arr.push(line);
      linesByRun.set(line.runId, arr);
    }

    return runs.map((r) => {
      const customer = byInternalId.get(r.customerId);
      return mapRun(
        r,
        customer?.publicId ?? "",
        customer?.name ?? "unknown customer",
        (linesByRun.get(r.id) ?? []).map(mapLineItemRow),
      );
    });
  });
}
