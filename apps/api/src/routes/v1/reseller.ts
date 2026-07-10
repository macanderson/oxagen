import { Hono } from "hono";
import { invoke } from "@oxagen/oxagen/kernel";
import { resellerCustomerCreate } from "@oxagen/oxagen/contracts/billing.reseller_customer.create";
import { resellerCustomerList } from "@oxagen/oxagen/contracts/billing.reseller_customer.list";
import { resellerCustomerUpdate } from "@oxagen/oxagen/contracts/billing.reseller_customer.update";
import { resellerCustomerArchive } from "@oxagen/oxagen/contracts/billing.reseller_customer.archive";
import { resellerPricePlanCreate } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.create";
import { resellerPricePlanList } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.list";
import { resellerPricePlanUpdate } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.update";
import { resellerAttributionRuleSave } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.save";
import { resellerAttributionRuleList } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.list";
import { resellerAttributionRuleDelete } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.delete";
import { resellerRebillPreview } from "@oxagen/oxagen/contracts/billing.reseller_rebill.preview";
import { resellerRebillPush } from "@oxagen/oxagen/contracts/billing.reseller_rebill.push";
import { resellerRebillListRuns } from "@oxagen/oxagen/contracts/billing.reseller_rebill.list_runs";
import { resellerStripeConfigure } from "@oxagen/oxagen/contracts/billing.reseller_stripe.configure";
import { resellerStripeStatus } from "@oxagen/oxagen/contracts/billing.reseller_stripe.status";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Combined reseller-revenue route — the /v1/:org/:workspace/billing/revenue/*
 * surface for the "Stripe for agents" re-bill loop. One file covers all 15
 * capabilities (established combined-route precedent); every handler parses the
 * contract input, builds the kernel context, and invokes with surface "api".
 */
export const resellerRoute = new Hono<AppEnv>();

// ── Customers ────────────────────────────────────────────────────────────────

resellerRoute.post("/customers", async (c) => {
  const body = resellerCustomerCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerCustomerCreate.name, body, ctx, { surface: "api" }),
  );
});

resellerRoute.get("/customers", async (c) => {
  const input = resellerCustomerList.input.parse({
    status: c.req.query("status") ?? undefined,
  });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerCustomerList.name, input, ctx, { surface: "api" }),
  );
});

resellerRoute.post("/customers/update", async (c) => {
  const body = resellerCustomerUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerCustomerUpdate.name, body, ctx, { surface: "api" }),
  );
});

resellerRoute.post("/customers/archive", async (c) => {
  const body = resellerCustomerArchive.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerCustomerArchive.name, body, ctx, { surface: "api" }),
  );
});

// ── Price plans ──────────────────────────────────────────────────────────────

resellerRoute.post("/price-plans", async (c) => {
  const body = resellerPricePlanCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerPricePlanCreate.name, body, ctx, { surface: "api" }),
  );
});

resellerRoute.get("/price-plans", async (c) => {
  const input = resellerPricePlanList.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerPricePlanList.name, input, ctx, { surface: "api" }),
  );
});

resellerRoute.post("/price-plans/update", async (c) => {
  const body = resellerPricePlanUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerPricePlanUpdate.name, body, ctx, { surface: "api" }),
  );
});

// ── Attribution rules ────────────────────────────────────────────────────────

resellerRoute.post("/attribution-rules", async (c) => {
  const body = resellerAttributionRuleSave.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerAttributionRuleSave.name, body, ctx, {
      surface: "api",
    }),
  );
});

resellerRoute.get("/attribution-rules", async (c) => {
  const input = resellerAttributionRuleList.input.parse({
    customerId: c.req.query("customer_id") ?? undefined,
  });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerAttributionRuleList.name, input, ctx, {
      surface: "api",
    }),
  );
});

resellerRoute.post("/attribution-rules/delete", async (c) => {
  const body = resellerAttributionRuleDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerAttributionRuleDelete.name, body, ctx, {
      surface: "api",
    }),
  );
});

// ── Re-bill ──────────────────────────────────────────────────────────────────

resellerRoute.post("/rebill/preview", async (c) => {
  const body = resellerRebillPreview.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerRebillPreview.name, body, ctx, { surface: "api" }),
  );
});

resellerRoute.post("/rebill/push", async (c) => {
  const body = resellerRebillPush.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerRebillPush.name, body, ctx, { surface: "api" }),
  );
});

resellerRoute.get("/rebill/runs", async (c) => {
  const limitRaw = c.req.query("limit");
  const input = resellerRebillListRuns.input.parse({
    customerId: c.req.query("customer_id") ?? undefined,
    limit: limitRaw ? Number(limitRaw) : undefined,
  });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerRebillListRuns.name, input, ctx, { surface: "api" }),
  );
});

// ── Stripe connection ────────────────────────────────────────────────────────

resellerRoute.post("/stripe/connect", async (c) => {
  const body = resellerStripeConfigure.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerStripeConfigure.name, body, ctx, { surface: "api" }),
  );
});

resellerRoute.get("/stripe/status", async (c) => {
  const input = resellerStripeStatus.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(resellerStripeStatus.name, input, ctx, { surface: "api" }),
  );
});
