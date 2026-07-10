/**
 * Unit tests for the combined /v1/:org/:ws/billing/revenue/* reseller route.
 *
 * The route's job is to parse the contract input from the request and forward it
 * to invoke with { surface: "api" }. `invoke` and `capabilityContext` are mocked
 * so no auth / DB / Stripe is involved — we assert the mapping for every endpoint
 * and that a malformed body is rejected by the contract before invoke is reached.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { resellerRoute } from "./reseller";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: "key_1",
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const START = "2026-07-01T00:00:00.000Z";
const END = "2026-07-10T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue({ ok: true });
});

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    resellerRoute.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}
function get(path: string): Promise<Response> {
  return Promise.resolve(
    resellerRoute.fetch(new Request(`http://localhost${path}`)),
  );
}

function lastCapability(): string {
  return mocks.invoke.mock.calls[0]![0] as string;
}

describe("reseller route — customers", () => {
  it("POST /customers → create_reseller_customer", async () => {
    const res = await post("/customers", { name: "Acme" });
    expect(res.status).toBe(200);
    expect(lastCapability()).toBe("create_reseller_customer");
    expect(mocks.invoke.mock.calls[0]![3]).toEqual({ surface: "api" });
  });

  it("GET /customers → list_reseller_customers (status query threaded)", async () => {
    await get("/customers?status=active");
    expect(lastCapability()).toBe("list_reseller_customers");
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({ status: "active" });
  });

  it("GET /customers with no status → status undefined", async () => {
    await get("/customers");
    expect(lastCapability()).toBe("list_reseller_customers");
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({ status: undefined });
  });

  it("POST /customers/update → update_reseller_customer", async () => {
    await post("/customers/update", { id: "rescus_1", name: "Renamed" });
    expect(lastCapability()).toBe("update_reseller_customer");
  });

  it("POST /customers/archive → archive_reseller_customer", async () => {
    await post("/customers/archive", { id: "rescus_1" });
    expect(lastCapability()).toBe("archive_reseller_customer");
  });
});

describe("reseller route — price plans", () => {
  it("POST /price-plans → create_reseller_price_plan", async () => {
    await post("/price-plans", {
      name: "Std",
      pricingMode: "markup",
      markupBps: 2000,
    });
    expect(lastCapability()).toBe("create_reseller_price_plan");
  });

  it("rejects a malformed plan (markup without markupBps) before invoke", async () => {
    const res = await post("/price-plans", {
      name: "Bad",
      pricingMode: "markup",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("GET /price-plans → list_reseller_price_plans", async () => {
    await get("/price-plans");
    expect(lastCapability()).toBe("list_reseller_price_plans");
  });

  it("POST /price-plans/update → update_reseller_price_plan", async () => {
    await post("/price-plans/update", { id: "resplan_1", name: "New" });
    expect(lastCapability()).toBe("update_reseller_price_plan");
  });
});

describe("reseller route — attribution rules", () => {
  it("POST /attribution-rules → save_reseller_attribution_rule", async () => {
    await post("/attribution-rules", {
      matchKind: "workspace",
      matchValue: "ws-1",
      matchLabel: "WS",
      customerId: "rescus_1",
      priority: 10,
    });
    expect(lastCapability()).toBe("save_reseller_attribution_rule");
  });

  it("GET /attribution-rules → list_reseller_attribution_rules (customer_id threaded)", async () => {
    await get("/attribution-rules?customer_id=rescus_1");
    expect(lastCapability()).toBe("list_reseller_attribution_rules");
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({ customerId: "rescus_1" });
  });

  it("GET /attribution-rules with no customer_id → customerId undefined", async () => {
    await get("/attribution-rules");
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({ customerId: undefined });
  });

  it("POST /attribution-rules/delete → delete_reseller_attribution_rule", async () => {
    await post("/attribution-rules/delete", { id: "resrule_1" });
    expect(lastCapability()).toBe("delete_reseller_attribution_rule");
  });
});

describe("reseller route — rebill", () => {
  it("POST /rebill/preview → preview_reseller_rebill", async () => {
    await post("/rebill/preview", { start: START, end: END });
    expect(lastCapability()).toBe("preview_reseller_rebill");
  });

  it("POST /rebill/push → push_reseller_rebill", async () => {
    await post("/rebill/push", {
      customerId: "rescus_1",
      start: START,
      end: END,
    });
    expect(lastCapability()).toBe("push_reseller_rebill");
  });

  it("GET /rebill/runs → list_reseller_rebill_runs (limit coerced to number)", async () => {
    await get("/rebill/runs?limit=10&customer_id=rescus_1");
    expect(lastCapability()).toBe("list_reseller_rebill_runs");
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({
      customerId: "rescus_1",
      limit: 10,
    });
  });

  it("GET /rebill/runs with no query → limit defaulted, customerId undefined", async () => {
    await get("/rebill/runs");
    // The route passes limit undefined; the contract's default (50) fills it.
    expect(mocks.invoke.mock.calls[0]![1]).toEqual({
      customerId: undefined,
      limit: 50,
    });
  });
});

describe("reseller route — stripe", () => {
  it("POST /stripe/connect → configure_reseller_stripe", async () => {
    await post("/stripe/connect", { secretKey: "sk_live_abcdef123456" });
    expect(lastCapability()).toBe("configure_reseller_stripe");
  });

  it("GET /stripe/status → get_reseller_stripe_status", async () => {
    await get("/stripe/status");
    expect(lastCapability()).toBe("get_reseller_stripe_status");
  });
});
