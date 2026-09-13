// The live billing adapter (Batch 3, lane A9).
//
// What is wired, after checking plan §3.2 at column level against
// packages/database/src/schema/billing.ts (the column map is in
// ./mappers/billing.ts and in the PR body):
//
//   plan        wired. `get_subscription` through the kernel as the signed-in
//               person (IAM decides; Owner, Admin and Billing may read), plus
//               `billing.plans.tier` for the returned plan slug through
//               withTenantDb (no capability returns the tier). A subscription
//               the view model cannot state honestly (none, trialing, paused,
//               cancelling at period end) reads as not backed, never a guess.
//   invoices    wired to billing.invoices through withTenantDb (no capability
//               lists invoices), gated by the same `get_subscription` IAM
//               decision so a member who may not read billing is denied. An
//               organization with no issued invoice reads as an empty list;
//               any issued invoice reads as not backed (M2, G13): no store
//               counts the runs an invoice billed, nor mirrors its issue date.
//   allowance,  not backed (M2, G13): the per-run billing allowance (§12.1)
//   meters      has no store; today's billing is the credits model.
//
// Every read runs in the caller's tenant scope. billing.subscriptions and
// billing.invoices are organization-only under RLS, so the organization
// sentinel workspace the Billing page carries is the right scope.
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import {
  type BillingSubscriptionReadOutput,
  billingSubscriptionRead,
} from "@oxagen/oxagen/contracts/billing.subscription.read";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq, ne } from "drizzle-orm";
import { cache } from "react";
import { notBackedFor } from "@/data/backing";
import { denied, type Read, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { BillingReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import { getSession } from "@/server/session";
import {
  type InvoiceRow,
  type PlanTierValue,
  readInvoices,
  toBillingPlan,
} from "./mappers/billing";

const BILLING = PAGE_FAILURES.billing;

/** Kernel codes that mean "this person may not read billing", not "the store failed". */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
  "surface_denied",
  "capability_not_installed",
]);

export function isCapabilityDenial(error: unknown): boolean {
  return error instanceof CapabilityError && DENIAL_CODES.has(error.code);
}

/** The I/O the adapter needs, injected so every branch is unit-tested without stores. */
export type BillingLiveDeps = {
  /** The signed-in person's user id; null without a session. */
  principal: () => Promise<string | null>;
  /** `get_subscription` as `userId` in `scope`, parsed by the contract's output schema. */
  subscription: (call: {
    scope: Scope;
    userId: string;
  }) => Promise<BillingSubscriptionReadOutput>;
  /** `billing.plans.tier` for a plan slug; null when no plan row has that slug. */
  planTier: (scope: Scope, slug: string) => Promise<PlanTierValue | null>;
  /** The organization's billing.invoices headers, newest first. */
  invoiceRows: (scope: Scope) => Promise<InvoiceRow[]>;
};

export function createLiveBilling(deps: BillingLiveDeps): BillingReadPort {
  /** The subscription read, or the denial the kernel returned for this person. */
  async function readSubscription(
    scope: Scope,
  ): Promise<Read<BillingSubscriptionReadOutput>> {
    const userId = await deps.principal();
    if (userId === null) return denied(BILLING.permission);
    try {
      return readOk(await deps.subscription({ scope, userId }));
    } catch (error) {
      if (isCapabilityDenial(error)) return denied(BILLING.permission);
      throw error;
    }
  }

  return {
    async plan(scope) {
      const read = await readSubscription(scope);
      if (!read.ok) return read;
      const { subscription } = read.value;
      const tier = subscription
        ? await deps.planTier(scope, subscription.planSlug)
        : null;
      return toBillingPlan({ subscription, tier });
    },

    async invoices(scope) {
      // No capability lists invoices: get_subscription's IAM decision (same
      // resource, same roles) gates the table read.
      const gate = await readSubscription(scope);
      if (!gate.ok) return gate;
      return readInvoices(await deps.invoiceRows(scope));
    },

    allowance: () => Promise.resolve(notBackedFor("billing", "allowance")),
    meters: () => Promise.resolve(notBackedFor("billing", "meters")),
  };
}

let handlersRegistered: Promise<unknown> | null = null;

async function invokeGetSubscription(
  orgId: string,
  workspaceId: string,
  userId: string,
): Promise<BillingSubscriptionReadOutput> {
  // The handler registry must be loaded before the first invoke(), or the
  // kernel finds no handler (the same rule src/server/invoke.ts follows).
  handlersRegistered ??= import("@oxagen/handlers/register");
  await handlersRegistered;
  const contract = billingSubscriptionRead;
  if (!getCapability(contract.name)) throw new ToolNotRegistered(contract.name);
  const scope: Scope = { orgId, workspaceId };
  const ctx: CapabilityContext = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
  const raw = await runInTenantScope(scope, () =>
    invoke(contract.name, {}, ctx),
  );
  const parsed = contract.output.safeParse(raw);
  if (!parsed.success)
    throw new ContractOutputMismatch(contract.name, parsed.error.issues);
  return parsed.data;
}

/**
 * One kernel read per request: `plan` and `invoices` render on the same page
 * and share the IAM decision. Primitive arguments, so React's per-request
 * cache keys on them.
 */
const subscriptionForRequest = cache(invokeGetSubscription);

/** The production I/O: the request's session, the kernel, and tenant-scoped Postgres. */
export const liveBillingDeps: BillingLiveDeps = {
  async principal() {
    return (await getSession())?.user.id ?? null;
  },

  subscription({ scope, userId }) {
    return subscriptionForRequest(scope.orgId, scope.workspaceId, userId);
  },

  async planTier(scope, slug) {
    const rows = await runInTenantScope(scope, () =>
      withTenantDb((tx) =>
        tx
          .select({ tier: schema.plans.tier })
          .from(schema.plans)
          .where(eq(schema.plans.slug, slug))
          .limit(1),
      ),
    );
    return rows[0]?.tier ?? null;
  },

  async invoiceRows(scope) {
    const invoices = schema.invoices;
    return runInTenantScope(scope, () =>
      withTenantDb((tx) =>
        tx
          .select({
            number: invoices.number,
            status: invoices.status,
            amountDueCents: invoices.amountDueCents,
            currency: invoices.currency,
            periodStart: invoices.periodStart,
          })
          .from(invoices)
          .where(
            and(eq(invoices.orgId, scope.orgId), ne(invoices.status, "draft")),
          )
          .orderBy(desc(invoices.createdAt)),
      ),
    );
  },
};

export const liveBilling: BillingReadPort = createLiveBilling(liveBillingDeps);
