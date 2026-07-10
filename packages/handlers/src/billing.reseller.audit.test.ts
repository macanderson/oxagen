/**
 * SOC2 audit-trail tests for the reseller-revenue handlers.
 *
 * Privileged reseller commercial-terms mutations (downstream customers, price
 * plans, attribution rules, BYO-Stripe configuration, rebill pushes) must write
 * a security_events row (CC6.3/CC6.8) just like the other billing mutations do.
 * These tests assert each handler emits the correct event through the
 * consolidated registry helper emitSecurityEvent — and that failures do NOT
 * emit. The read-only reseller handlers (list / preview / status) are
 * audit-exempt and asserted statically by
 * packages/compliance/src/audit-coverage.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createResellerCustomer: vi.fn(),
  updateResellerCustomer: vi.fn(),
  archiveResellerCustomer: vi.fn(),
  createResellerPricePlan: vi.fn(),
  updateResellerPricePlan: vi.fn(),
  saveResellerAttributionRule: vi.fn(),
  deleteResellerAttributionRule: vi.fn(),
  configureResellerStripe: vi.fn(),
  pushResellerRebill: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  createResellerCustomer: mocks.createResellerCustomer,
  updateResellerCustomer: mocks.updateResellerCustomer,
  archiveResellerCustomer: mocks.archiveResellerCustomer,
  createResellerPricePlan: mocks.createResellerPricePlan,
  updateResellerPricePlan: mocks.updateResellerPricePlan,
  saveResellerAttributionRule: mocks.saveResellerAttributionRule,
  deleteResellerAttributionRule: mocks.deleteResellerAttributionRule,
  configureResellerStripe: mocks.configureResellerStripe,
  pushResellerRebill: mocks.pushResellerRebill,
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

import { resellerCustomerCreateHandler } from "./billing.reseller_customer.create";
import { resellerCustomerUpdateHandler } from "./billing.reseller_customer.update";
import { resellerCustomerArchiveHandler } from "./billing.reseller_customer.archive";
import { resellerPricePlanCreateHandler } from "./billing.reseller_price_plan.create";
import { resellerPricePlanUpdateHandler } from "./billing.reseller_price_plan.update";
import { resellerAttributionRuleSaveHandler } from "./billing.reseller_attribution_rule.save";
import { resellerAttributionRuleDeleteHandler } from "./billing.reseller_attribution_rule.delete";
import { resellerStripeConfigureHandler } from "./billing.reseller_stripe.configure";
import { resellerRebillPushHandler } from "./billing.reseller_rebill.push";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

// One row per mutating handler: [name, handler, input, billing-fn mock, expected
// eventType, expected capability]. The handler's return value is irrelevant to
// the audit invariant — the billing fn resolves to a minimal shape.
const cases: Array<{
  name: string;
  run: (c: typeof ctx) => Promise<unknown>;
  billingFn: ReturnType<typeof vi.fn>;
  eventType: string;
  capability: string;
}> = [
  {
    name: "billing.reseller_customer.create",
    run: (c) =>
      resellerCustomerCreateHandler({ name: "Acme" } as never, c as never),
    billingFn: mocks.createResellerCustomer,
    eventType: "billing.reseller_customer_changed",
    capability: "create_reseller_customer",
  },
  {
    name: "billing.reseller_customer.update",
    run: (c) =>
      resellerCustomerUpdateHandler({ id: "cus-1" } as never, c as never),
    billingFn: mocks.updateResellerCustomer,
    eventType: "billing.reseller_customer_changed",
    capability: "update_reseller_customer",
  },
  {
    name: "billing.reseller_customer.archive",
    run: (c) =>
      resellerCustomerArchiveHandler({ id: "cus-1" } as never, c as never),
    billingFn: mocks.archiveResellerCustomer,
    eventType: "billing.reseller_customer_changed",
    capability: "archive_reseller_customer",
  },
  {
    name: "billing.reseller_price_plan.create",
    run: (c) =>
      resellerPricePlanCreateHandler(
        { name: "Plan", pricingMode: "markup", currency: "usd" } as never,
        c as never,
      ),
    billingFn: mocks.createResellerPricePlan,
    eventType: "billing.reseller_price_plan_changed",
    capability: "create_reseller_price_plan",
  },
  {
    name: "billing.reseller_price_plan.update",
    run: (c) =>
      resellerPricePlanUpdateHandler({ id: "plan-1" } as never, c as never),
    billingFn: mocks.updateResellerPricePlan,
    eventType: "billing.reseller_price_plan_changed",
    capability: "update_reseller_price_plan",
  },
  {
    name: "billing.reseller_attribution_rule.save",
    run: (c) =>
      resellerAttributionRuleSaveHandler(
        {
          matchKind: "workspace",
          matchValue: "ws-1",
          customerId: "cus-1",
        } as never,
        c as never,
      ),
    billingFn: mocks.saveResellerAttributionRule,
    eventType: "billing.reseller_attribution_rule_changed",
    capability: "save_reseller_attribution_rule",
  },
  {
    name: "billing.reseller_attribution_rule.delete",
    run: (c) =>
      resellerAttributionRuleDeleteHandler(
        { id: "rule-1" } as never,
        c as never,
      ),
    billingFn: mocks.deleteResellerAttributionRule,
    eventType: "billing.reseller_attribution_rule_changed",
    capability: "delete_reseller_attribution_rule",
  },
  {
    name: "billing.reseller_stripe.configure",
    run: (c) =>
      resellerStripeConfigureHandler(
        { secretKey: "sk_test_x" } as never,
        c as never,
      ),
    billingFn: mocks.configureResellerStripe,
    eventType: "billing.reseller_stripe_configured",
    capability: "configure_reseller_stripe",
  },
  {
    name: "billing.reseller_rebill.push",
    run: (c) =>
      resellerRebillPushHandler(
        {
          customerId: "cus-1",
          start: "2026-07-01",
          end: "2026-07-31",
          finalize: false,
        } as never,
        c as never,
      ),
    billingFn: mocks.pushResellerRebill,
    eventType: "billing.reseller_rebill_pushed",
    capability: "push_reseller_rebill",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const c of cases) c.billingFn.mockResolvedValue({});
});

// ── Audit invariant per mutating handler ─────────────────────────────────────

describe.each(cases)(
  "$name — audit event",
  ({ run, billingFn, eventType, capability }) => {
    it(`emits ${eventType} on success`, async () => {
      await run(ctx);
      expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
      expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType,
          actorUserId: "user-1",
          orgId: "org-1",
          workspaceId: "ws-1",
          capability,
          outcome: "success",
          requestId: "req-1",
        }),
      );
    });

    it("does NOT emit when the billing mutation fails", async () => {
      billingFn.mockRejectedValue(new Error("stripe down"));
      await expect(run(ctx)).rejects.toThrow("stripe down");
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    });

    it("does NOT emit for an unauthenticated caller", async () => {
      await expect(
        run({ ...ctx, userId: null as never, apiKeyId: null }),
      ).rejects.toThrow("Unauthorized");
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    });
  },
);
