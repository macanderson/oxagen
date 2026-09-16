/**
 * purchase_credits (WL-67, apps/app/ARCHITECTURE.md §1.4, §3.9 the second
 * meter).
 *
 * The handler runs against the real role gate and the real
 * `resolveActingUserId`; only the database and the credit checkout are faked.
 * The fake database answers by table for the organisation whose tenant scope
 * is active and records every table it is asked about. Every organisation in
 * the fixture is tier `free`, the tier for which the kernel's IAM check allows
 * every capability, so a refusal can only come from the handler's own gate
 * (INV-29).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The world the fake database answers from. */
interface OrgWorld {
  /** The acting user's org role, or null for a user with none. */
  role: string | null;
}

const { world, scope, log, key } = vi.hoisted(() => ({
  world: new Map<string, unknown>(),
  scope: { orgId: "" },
  /** The user the API key in these tests was created by, or none. */
  key: { creator: "usr_creator" as string | null },
  log: { tablesRead: [] as string[] },
}));

const PRINCIPAL_ID = "prn_actor";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const here = () => {
    const w = world.get(scope.orgId) as OrgWorld | undefined;
    if (!w) throw new Error(`no tenant scope entered for ${scope.orgId}`);
    return w;
  };
  const nameOf = (table: unknown): string => {
    for (const [k, v] of Object.entries(real.schema)) if (v === table) return k;
    return "unknown";
  };
  const rowsFor = (table: unknown): unknown[] => {
    const w = here();
    log.tablesRead.push(nameOf(table));
    if (table === real.schema.apiKeys)
      return key.creator ? [{ createdByUserId: key.creator }] : [];
    if (table === real.schema.principals) return [{ id: PRINCIPAL_ID }];
    if (table === real.schema.principalRoleAssignments)
      return w.role ? [{ roleName: w.role }] : [];
    throw new Error(`unexpected table ${nameOf(table)}`);
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rowsFor(table)),
        };
        return chain;
      },
    }),
  };
  return {
    ...real,
    withTenantDb: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
});

const emitSecurityEvent = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent }));

const createUsageCreditCheckout = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return { ...real, createUsageCreditCheckout };
});

import { isHandlerError } from "@oxagen/oxagen";
import { billingCreditsPurchaseHandler } from "./billing.credits.purchase";

// ── helpers ──────────────────────────────────────────────────────────────────

const ORG = "00000000-0000-0000-0000-00000000c0c1";

const CHECKOUT = {
  url: "https://checkout.stripe.com/c/pay/cs_test_credits",
  sessionId: "cs_test_credits",
  grantCents: 5_000,
  priceCents: 4_850,
  percent: 3,
};

function ctxFor(
  orgId: string,
  userId: string | null = "usr_actor",
  apiKeyId: string | null = null,
) {
  return {
    orgId,
    workspaceId: "ws_1",
    userId,
    apiKeyId,
    requestId: "req_1",
    surface: "api" as const,
    messageId: null,
    executionStepId: null,
  };
}

/** Enter the org's tenant scope and run the top-up, as the kernel would. */
async function topUp(
  { amountUsd }: { amountUsd: number } = { amountUsd: 50 },
  userId: string | null = "usr_actor",
  apiKeyId: string | null = null,
  orgId: string = ORG,
) {
  scope.orgId = orgId;
  return billingCreditsPurchaseHandler(
    { amountUsd },
    ctxFor(orgId, userId, apiKeyId),
  );
}

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

beforeEach(() => {
  vi.clearAllMocks();
  log.tablesRead.length = 0;
  key.creator = "usr_creator";
  world.clear();
  world.set(ORG, { role: "Owner" });
  createUsageCreditCheckout.mockResolvedValue(CHECKOUT);
});

afterEach(() => {
  world.clear();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("purchase_credits handler", () => {
  it("opens a Checkout for an Owner and returns the URL, the grant and the price", async () => {
    const out = await topUp();

    expect(out).toEqual({
      url: CHECKOUT.url,
      grantCents: 5_000,
      priceCents: 4_850,
      percent: 3,
    });
    expect(createUsageCreditCheckout).toHaveBeenCalledOnce();
    expect(createUsageCreditCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, grantCents: 5_000 }),
    );
  });

  it("the Billing role may top up", async () => {
    world.set(ORG, { role: "Billing" });
    await expect(topUp()).resolves.toMatchObject({ url: CHECKOUT.url });
  });

  it.each(["Admin", "Member", "Viewer", "Compliance"])(
    "refuses %s on a tier-free org with HandlerError forbidden, opening no Checkout (negative)",
    async (role) => {
      world.set(ORG, { role });

      await expect(topUp()).rejects.toSatisfy(forbidden);
      expect(createUsageCreditCheckout).not.toHaveBeenCalled();
      expect(emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it("refuses a user who holds no role in the organization (negative)", async () => {
    world.set(ORG, { role: null });

    await expect(topUp()).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(createUsageCreditCheckout).not.toHaveBeenCalled();
  });

  it("refuses a caller with no user and no API key as forbidden (negative)", async () => {
    await expect(topUp({ amountUsd: 50 }, null)).rejects.toMatchObject({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(createUsageCreditCheckout).not.toHaveBeenCalled();
  });

  describe("an API-key call acts as the key's creator", () => {
    const topUpAsKey = () => topUp({ amountUsd: 50 }, null, "aky_1");

    it("tops up for a creator who is an org Owner, and the security event names the creator", async () => {
      await expect(topUpAsKey()).resolves.toMatchObject({ url: CHECKOUT.url });
      expect(emitSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: "usr_creator" }),
      );
    });

    it("refuses a key whose creator is an org Admin (negative)", async () => {
      world.set(ORG, { role: "Admin" });
      await expect(topUpAsKey()).rejects.toMatchObject({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(createUsageCreditCheckout).not.toHaveBeenCalled();
    });

    it("refuses a key with no recorded creator (negative)", async () => {
      key.creator = null;
      await expect(topUpAsKey()).rejects.toMatchObject({
        code: "forbidden",
        reason: "no_principal",
      });
      expect(createUsageCreditCheckout).not.toHaveBeenCalled();
    });
  });

  it("converts the dollar amount to whole cents of face value", async () => {
    await topUp({ amountUsd: 250 });

    expect(createUsageCreditCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ grantCents: 25_000 }),
    );
  });

  it("refuses a call with no organisation scope, reading no table (negative)", async () => {
    scope.orgId = ORG;
    await expect(
      billingCreditsPurchaseHandler({ amountUsd: 50 }, ctxFor("")),
    ).rejects.toThrow(/Forbidden/);
    expect(log.tablesRead).toEqual([]);
    expect(createUsageCreditCheckout).not.toHaveBeenCalled();
  });

  it("records the checkout as a security event under the capability's name", async () => {
    await topUp();

    expect(emitSecurityEvent).toHaveBeenCalledOnce();
    expect(emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.checkout_initiated",
        capability: "purchase_credits",
        orgId: ORG,
        actorUserId: "usr_actor",
        outcome: "success",
      }),
    );
  });

  it("emits no security event when the checkout could not be created (negative)", async () => {
    createUsageCreditCheckout.mockRejectedValue(new Error("stripe down"));

    await expect(topUp()).rejects.toThrow("stripe down");
    expect(emitSecurityEvent).not.toHaveBeenCalled();
  });
});
