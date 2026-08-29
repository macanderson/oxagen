"use server";

import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it invoke()
// throws "No handler registered". Mirrors the other app-side invoke call sites.
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { revalidatePath } from "next/cache";
import type {
  ResellerCustomer,
  ResellerPricePlan,
  ResellerAttributionRule,
  ResellerRebillRun,
  ResellerRebillPreview,
} from "@oxagen/oxagen/contracts/reseller-shared";
import { getSession } from "@/lib/session";
import { resolveOrg, assertBillingManager } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only billing routes — the reseller tables use an
// org-only RLS policy, so the workspace GUC is set but never evaluated.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const NOT_AUTHORIZED =
  "You don't have permission to manage revenue for this organization.";

type Gate = { orgId: string; userId: string } | { error: string };

/**
 * Billing-manager gate for every reseller action. apps/app does not bootstrap
 * kernel IAM, so this is THE authorization check before invoke(): resolve the
 * org, require an authenticated principal, and assert an owner/admin/billing role
 * (assertBillingManager throws when the caller lacks it).
 */
async function gate(orgSlug: string): Promise<Gate> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { error: "Not authenticated." };
  const org = await resolveOrg(orgSlug);
  try {
    await assertBillingManager(org.id, userId);
  } catch {
    return { error: NOT_AUTHORIZED };
  }
  return { orgId: org.id, userId };
}

/** Build the app-surface kernel context + run the invoke inside the tenant scope. */
async function invokeReseller<T>(
  orgId: string,
  userId: string,
  name: string,
  input: unknown,
): Promise<T> {
  const ctx = {
    orgId,
    workspaceId: ORG_ONLY_WS,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
  // No opts.surface: the reseller contracts expose ["api","mcp"], and claiming
  // "agent" from the app made the kernel surface-deny every mutation on this
  // page (the equip-sources pattern — app-side invokes omit the surface claim).
  return runInTenantScope({ orgId, workspaceId: ORG_ONLY_WS }, () =>
    invoke(name, input, ctx),
  ) as Promise<T>;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ── Customers ────────────────────────────────────────────────────────────────

export async function createCustomerAction(
  orgSlug: string,
  input: {
    name: string;
    externalRef?: string | null;
    pricePlanId?: string | null;
  },
): Promise<
  { ok: true; customer: ResellerCustomer } | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { customer } = await invokeReseller<{ customer: ResellerCustomer }>(
      g.orgId,
      g.userId,
      "create_reseller_customer",
      input,
    );
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true, customer };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to create customer") };
  }
}

export async function updateCustomerAction(
  orgSlug: string,
  input: {
    id: string;
    name?: string;
    externalRef?: string | null;
    pricePlanId?: string | null;
    status?: "active" | "paused";
  },
): Promise<
  { ok: true; customer: ResellerCustomer } | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { customer } = await invokeReseller<{ customer: ResellerCustomer }>(
      g.orgId,
      g.userId,
      "update_reseller_customer",
      input,
    );
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true, customer };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to update customer") };
  }
}

export async function archiveCustomerAction(
  orgSlug: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    await invokeReseller(g.orgId, g.userId, "archive_reseller_customer", {
      id,
    });
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to archive customer") };
  }
}

// ── Price plans ──────────────────────────────────────────────────────────────

export async function createPricePlanAction(
  orgSlug: string,
  input: {
    name: string;
    pricingMode: "markup" | "per_unit";
    markupBps?: number | null;
    unitPriceCents?: number | null;
    currency?: string;
  },
): Promise<
  { ok: true; pricePlan: ResellerPricePlan } | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { pricePlan } = await invokeReseller<{
      pricePlan: ResellerPricePlan;
    }>(g.orgId, g.userId, "create_reseller_price_plan", {
      currency: "usd",
      ...input,
    });
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true, pricePlan };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to create price plan") };
  }
}

export async function updatePricePlanAction(
  orgSlug: string,
  input: {
    id: string;
    name?: string;
    pricingMode?: "markup" | "per_unit";
    markupBps?: number | null;
    unitPriceCents?: number | null;
    currency?: string;
  },
): Promise<
  { ok: true; pricePlan: ResellerPricePlan } | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { pricePlan } = await invokeReseller<{
      pricePlan: ResellerPricePlan;
    }>(g.orgId, g.userId, "update_reseller_price_plan", input);
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true, pricePlan };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to update price plan") };
  }
}

// ── Attribution rules ────────────────────────────────────────────────────────

export async function saveAttributionRuleAction(
  orgSlug: string,
  input: {
    id?: string;
    matchKind: "workspace" | "principal" | "capability";
    matchValue: string;
    matchLabel: string;
    customerId: string;
    priority: number;
  },
): Promise<
  { ok: true; rule: ResellerAttributionRule } | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const { rule } = await invokeReseller<{ rule: ResellerAttributionRule }>(
      g.orgId,
      g.userId,
      "save_reseller_attribution_rule",
      input,
    );
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true, rule };
  } catch (err) {
    return {
      ok: false,
      error: message(err, "Failed to save attribution rule"),
    };
  }
}

export async function deleteAttributionRuleAction(
  orgSlug: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    await invokeReseller(
      g.orgId,
      g.userId,
      "delete_reseller_attribution_rule",
      { id },
    );
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: message(err, "Failed to delete attribution rule"),
    };
  }
}

// ── Re-bill ──────────────────────────────────────────────────────────────────

export async function previewRebillAction(
  orgSlug: string,
  input: { start: string; end: string; customerId?: string },
): Promise<
  | {
      ok: true;
      previews: ResellerRebillPreview[];
      unattributedCostCents: number;
    }
  | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const out = await invokeReseller<{
      previews: ResellerRebillPreview[];
      unattributedCostCents: number;
    }>(g.orgId, g.userId, "preview_reseller_rebill", input);
    return {
      ok: true,
      previews: out.previews,
      unattributedCostCents: out.unattributedCostCents,
    };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to preview re-bill") };
  }
}

export async function pushRebillAction(
  orgSlug: string,
  input: { customerId: string; start: string; end: string; finalize?: boolean },
): Promise<
  | { ok: true; run: ResellerRebillRun; needsStripeConnection: boolean }
  | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const out = await invokeReseller<{
      run: ResellerRebillRun;
      needsStripeConnection: boolean;
    }>(g.orgId, g.userId, "push_reseller_rebill", { finalize: true, ...input });
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return {
      ok: true,
      run: out.run,
      needsStripeConnection: out.needsStripeConnection,
    };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to push re-bill") };
  }
}

// ── Stripe connection ────────────────────────────────────────────────────────

export async function configureStripeAction(
  orgSlug: string,
  input: { secretKey: string; accountLabel?: string | null },
): Promise<
  | { ok: true; accountLabel: string | null; keyLast4: string }
  | { ok: false; error: string }
> {
  const g = await gate(orgSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const out = await invokeReseller<{
      accountLabel: string | null;
      keyLast4: string;
    }>(g.orgId, g.userId, "configure_reseller_stripe", input);
    revalidatePath(`/${orgSlug}/billing/revenue`);
    return { ok: true, accountLabel: out.accountLabel, keyLast4: out.keyLast4 };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to connect Stripe") };
  }
}
