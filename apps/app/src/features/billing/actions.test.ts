// The purchase action through the real viewer and kernel seams: the session,
// the pre-scope lookups and the kernel's invoke() are the only fakes, so each
// case shows what the person gets back, whether purchase_gau_bucket ran and
// where the browser was sent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getSession, orgRole, redirect, captureError } = vi.hoisted(
  () => ({
    invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
    getSession: vi.fn(),
    orgRole: vi.fn<() => Promise<string | null>>(),
    redirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    }),
    captureError: vi.fn(),
  }),
);
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("next/navigation", () => ({
  redirect,
  permanentRedirect: redirect,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// requireViewer defers its clock read behind connection(), which needs a request scope.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: {
    orgBySlug: (slug: string) =>
      Promise.resolve(
        slug === "acme"
          ? { id: ORG_ID, publicId: "org_01", slug: "acme", name: "Acme" }
          : null,
      ),
    orgBySlugHistory: () => Promise.resolve(null),
    orgRole,
    mfaPolicy: () => Promise.resolve(null),
    ssoPolicy: () => Promise.resolve(null),
    twoFactorEnabled: () => Promise.resolve(false),
  },
}));

const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";
const CHECKOUT =
  "https://checkout.stripe.com/c/pay/cs_test_a1B2#fidkdWxOYHwnPyd1blpxYHZxWjA0";

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { purchaseCredits, purchaseGau, startPlanChange } = await import(
  "./actions"
);

function quantity(value: string): FormData {
  const form = new FormData();
  form.set("quantityGau", value);
  return form;
}

const session = (blockSizeGau: number, checkoutUrl = CHECKOUT) => ({
  checkoutUrl,
  quantityGau: 2 * blockSizeGau,
  blockSizeGau,
  blocks: 2,
});

beforeEach(() => {
  invoke.mockReset();
  redirect.mockClear();
  captureError.mockClear();
  orgRole.mockResolvedValue("owner");
  getSession.mockResolvedValue({
    user: { id: "u-owner", email: "priya@acme.example" },
  });
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
});

describe("purchaseGau", () => {
  it("sends a signed-out visitor to log in, buying nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(
      purchaseGau("acme", 5000, null, quantity("10000")),
    ).rejects.toThrow("NEXT_REDIRECT /login");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["not a multiple of the block size", 5000, "7500"],
    ["zero", 5000, "0"],
    ["negative", 5000, "-5000"],
    ["a fraction", 5000, "5000.5"],
    ["an exponent", 5000, "1e4"],
    ["empty", 5000, ""],
    ["past a safe integer", 5000, "90071992547409920"],
    ["against a block size of zero", 0, "5000"],
  ])(
    "refuses a quantity %s on the quantity field, calling no capability (negative)",
    async (_case, blockSizeGau, value) => {
      expect(
        await purchaseGau("acme", blockSizeGau, null, quantity(value)),
      ).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "quantityGau",
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it("refuses a form with no quantity field (negative)", async () => {
    expect(await purchaseGau("acme", 5000, null, new FormData())).toMatchObject(
      { ok: false, reason: "invalid", field: "quantityGau" },
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses whole blocks above the contract's maximum with their own code, calling no capability (negative)", async () => {
    expect(await purchaseGau("acme", 5000, null, quantity("1005000"))).toEqual({
      ok: false,
      reason: "invalid",
      code: "quantity_above_max",
      field: "quantityGau",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal to an admin as denied, with no redirect (negative)", async () => {
    orgRole.mockResolvedValue("admin");
    // The refusal assertOrgRole throws for a role outside Owner and Billing.
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(await purchaseGau("acme", 5000, null, quantity("10000"))).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns an invoice-billed organization's refusal as conflict, with no redirect (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "conflict", reason: "invoice_billed" }),
    );
    expect(await purchaseGau("acme", 5000, null, quantity("10000"))).toEqual({
      ok: false,
      reason: "conflict",
      code: "invoice_billed",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", "https://checkout.stripe.com.evil/c/pay/cs_test_1"],
    ["plain http", "http://checkout.stripe.com/c/pay/cs_test_1"],
  ])(
    "refuses a Checkout URL on %s as unavailable, reports it and sends the browser nowhere (negative)",
    async (_case, checkoutUrl) => {
      invoke.mockResolvedValue(session(5000, checkoutUrl));
      expect(await purchaseGau("acme", 5000, null, quantity("10000"))).toEqual({
        ok: false,
        reason: "unavailable",
        code: "checkout_url_refused",
      });
      expect(redirect).not.toHaveBeenCalled();
      expect(captureError).toHaveBeenCalledOnce();
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID }),
      );
    },
  );

  it("buys the quantity for the viewer's organization with returns to the checkout banner, and sends the browser to Checkout", async () => {
    invoke.mockResolvedValue(session(5000));
    await expect(
      purchaseGau("acme", 5000, null, quantity("10000")),
    ).rejects.toThrow(`NEXT_REDIRECT ${CHECKOUT}`);
    expect(invoke).toHaveBeenCalledWith(
      "purchase_gau_bucket",
      {
        quantityGau: 10000,
        successPath: "/acme/billing?checkout=success",
        cancelPath: "/acme/billing?checkout=cancel",
      },
      expect.objectContaining({ orgId: ORG_ID, userId: "u-owner" }),
    );
    expect(redirect).toHaveBeenCalledExactlyOnceWith(CHECKOUT);
  });

  it("opens Checkout for a billing member of a Free organization with no saved card: neither the action nor the handler checks for one", async () => {
    // The handler answers a Free org with no payment_methods row with a
    // session (WL-28); the Checkout it opens is what saves the card.
    orgRole.mockResolvedValue("billing");
    invoke.mockResolvedValue(session(5000));
    await expect(
      purchaseGau("acme", 5000, null, quantity("5000")),
    ).rejects.toThrow(`NEXT_REDIRECT ${CHECKOUT}`);
    expect(invoke).toHaveBeenCalledOnce();
  });
});

function amount(value: string): FormData {
  const form = new FormData();
  form.set("amountUsd", value);
  return form;
}

/** What purchase_credits answers: a Checkout URL, the grant and the price. */
const creditSession = (url = CHECKOUT) => ({
  url,
  grantCents: 5000,
  priceCents: 4850,
  percent: 3,
});

describe("purchaseCredits", () => {
  it("sends a signed-out visitor to log in, topping up nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(purchaseCredits("acme", null, amount("50"))).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["under the minimum", "4"],
    ["zero", "0"],
    ["negative", "-50"],
    ["a fraction", "50.5"],
    ["an exponent", "5e1"],
    ["empty", ""],
    ["past a safe integer", "90071992547409920"],
  ])(
    "refuses an amount %s on the amount field, calling no capability (negative)",
    async (_case, value) => {
      expect(await purchaseCredits("acme", null, amount(value))).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "amountUsd",
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it("refuses a form with no amount field (negative)", async () => {
    expect(await purchaseCredits("acme", null, new FormData())).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "amountUsd",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal to an admin as denied, with no redirect (negative)", async () => {
    orgRole.mockResolvedValue("admin");
    // The refusal assertOrgRole throws for a role outside Owner and Billing.
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(await purchaseCredits("acme", null, amount("50"))).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", "https://checkout.stripe.com.evil/c/pay/cs_test_1"],
    ["plain http", "http://checkout.stripe.com/c/pay/cs_test_1"],
  ])(
    "refuses a Checkout URL on %s as unavailable, reports it and sends the browser nowhere (negative)",
    async (_case, url) => {
      invoke.mockResolvedValue(creditSession(url));
      expect(await purchaseCredits("acme", null, amount("50"))).toEqual({
        ok: false,
        reason: "unavailable",
        code: "checkout_url_refused",
      });
      expect(redirect).not.toHaveBeenCalled();
      expect(captureError).toHaveBeenCalledOnce();
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID }),
      );
    },
  );

  it("refuses to guess the return origin when NEXT_PUBLIC_APP_URL is unset (negative)", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(await purchaseCredits("acme", null, amount("50"))).toEqual({
      ok: false,
      reason: "unavailable",
      code: "app_url_missing",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledOnce();
  });

  // Success returns to ?checkout=credits, the usage credit meter's outcome, so
  // the banner names the balance the payment lands on; ?checkout=success is the
  // governed action unit bucket's. Cancel is shared: nothing was charged.
  it("tops up for the viewer's organization with returns to the checkout banner, and sends the browser to Checkout", async () => {
    invoke.mockResolvedValue(creditSession());
    await expect(purchaseCredits("acme", null, amount("50"))).rejects.toThrow(
      `NEXT_REDIRECT ${CHECKOUT}`,
    );
    expect(invoke).toHaveBeenCalledWith(
      "purchase_credits",
      {
        amountUsd: 50,
        successUrl: "https://app.test/acme/billing?checkout=credits",
        cancelUrl: "https://app.test/acme/billing?checkout=cancel",
      },
      expect.objectContaining({ orgId: ORG_ID, userId: "u-owner" }),
    );
    expect(redirect).toHaveBeenCalledExactlyOnceWith(CHECKOUT);
  });

  it("builds the return URLs whatever trailing slash the origin carries", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test/";
    invoke.mockResolvedValue(creditSession());
    await expect(purchaseCredits("acme", null, amount("200"))).rejects.toThrow(
      `NEXT_REDIRECT ${CHECKOUT}`,
    );
    expect(invoke).toHaveBeenCalledWith(
      "purchase_credits",
      expect.objectContaining({
        amountUsd: 200,
        successUrl: "https://app.test/acme/billing?checkout=credits",
      }),
      expect.anything(),
    );
  });
});

function plan(planSlug: string, interval: "month" | "year"): FormData {
  const form = new FormData();
  form.set("planSlug", planSlug);
  form.set("interval", interval);
  return form;
}

/** What start_subscription_upgrade answers: a Checkout URL and the plan it started. */
const planSession = (
  checkoutUrl = CHECKOUT,
  planSlug = "build-v2",
  interval: "month" | "year" = "month",
) => ({ checkoutUrl, planSlug, interval });

describe("startPlanChange", () => {
  it("sends a signed-out visitor to log in, changing nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(
      startPlanChange("acme", null, plan("build-v2", "month")),
    ).rejects.toThrow("NEXT_REDIRECT /login");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["not one of the offered plans", "enterprise-v2"],
    ["empty", ""],
    ["missing", null],
  ])(
    "refuses a plan slug %s on the planSlug field, calling no capability (negative)",
    async (_case, planSlug) => {
      const form = new FormData();
      if (planSlug !== null) form.set("planSlug", planSlug);
      form.set("interval", "month");
      expect(await startPlanChange("acme", null, form)).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "planSlug",
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["neither month nor year", "annually"],
    ["empty", ""],
    ["missing", null],
  ])(
    "refuses an interval %s on the interval field, calling no capability (negative)",
    async (_case, interval) => {
      const form = new FormData();
      form.set("planSlug", "build-v2");
      if (interval !== null) form.set("interval", interval);
      expect(await startPlanChange("acme", null, form)).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "interval",
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it("refuses to guess the return origin when NEXT_PUBLIC_APP_URL is unset (negative)", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      await startPlanChange("acme", null, plan("build-v2", "month")),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: "app_url_missing",
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("returns the handler's role refusal to an admin as denied, with no redirect (negative)", async () => {
    orgRole.mockResolvedValue("admin");
    // The refusal assertOrgRole throws for a role outside Owner and Billing.
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(
      await startPlanChange("acme", null, plan("build-v2", "month")),
    ).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  // createCheckoutSession's ActiveSubscriptionError is reclassified by the
  // handler into a HandlerError with code "conflict", which the kernel seam
  // passes through with the handler's reason as the ActionResult's code.
  it("returns an organization's existing-subscription refusal as conflict, with no redirect (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "active_subscription_exists",
      }),
    );
    expect(
      await startPlanChange("acme", null, plan("build-v2", "month")),
    ).toEqual({
      ok: false,
      reason: "conflict",
      code: "active_subscription_exists",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["another host", "https://checkout.stripe.com.evil/c/pay/cs_test_1"],
    ["plain http", "http://checkout.stripe.com/c/pay/cs_test_1"],
  ])(
    "refuses a Checkout URL on %s as unavailable, reports it and sends the browser nowhere (negative)",
    async (_case, checkoutUrl) => {
      invoke.mockResolvedValue(planSession(checkoutUrl));
      expect(
        await startPlanChange("acme", null, plan("build-v2", "month")),
      ).toEqual({
        ok: false,
        reason: "unavailable",
        code: "checkout_url_refused",
      });
      expect(redirect).not.toHaveBeenCalled();
      expect(captureError).toHaveBeenCalledOnce();
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID }),
      );
    },
  );

  it("starts the plan change for the viewer's organization with returns to the checkout banner, and sends the browser to Checkout", async () => {
    invoke.mockResolvedValue(planSession());
    await expect(
      startPlanChange("acme", null, plan("scale-v2", "year")),
    ).rejects.toThrow(`NEXT_REDIRECT ${CHECKOUT}`);
    expect(invoke).toHaveBeenCalledWith(
      "start_subscription_upgrade",
      {
        planSlug: "scale-v2",
        interval: "year",
        successUrl: "https://app.test/acme/billing?checkout=plan",
        cancelUrl: "https://app.test/acme/billing?checkout=cancel",
      },
      expect.objectContaining({ orgId: ORG_ID, userId: "u-owner" }),
    );
    expect(redirect).toHaveBeenCalledExactlyOnceWith(CHECKOUT);
  });

  it("builds the return URLs whatever trailing slash the origin carries", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test/";
    invoke.mockResolvedValue(planSession());
    await expect(
      startPlanChange("acme", null, plan("build-v2", "month")),
    ).rejects.toThrow(`NEXT_REDIRECT ${CHECKOUT}`);
    expect(invoke).toHaveBeenCalledWith(
      "start_subscription_upgrade",
      expect.objectContaining({
        successUrl: "https://app.test/acme/billing?checkout=plan",
        cancelUrl: "https://app.test/acme/billing?checkout=cancel",
      }),
      expect.anything(),
    );
  });
});
