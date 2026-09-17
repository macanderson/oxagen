/**
 * get_contract_rate (WL-26, ADR-055 §3, apps/app/ARCHITECTURE.md §3.9).
 *
 * The handler runs against the real `resolveContractTerms`; only the database
 * is faked. The fake answers by table, and by the organisation whose tenant
 * scope is active — the kernel enters that scope before a scoped handler runs
 * and RLS then answers only that organisation's rows, so `enterScope` here is
 * the test's stand-in for it. Every organisation in the fixture is tier
 * `free`, the tier for which the kernel's IAM check allows every capability,
 * so a refusal can only come from the handler's own role gate (INV-29).
 *
 * The seeded rates are deliberately unlike every `ACTION_RATE_BANDS` figure,
 * and one test asserts that distinctness, so a handler that priced from the
 * retired dollar bands could not pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── the world the fake database answers from ─────────────────────────────────

interface PlanRow {
  tier: string;
  currency: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  updatedAt: Date;
}

interface NegotiatedRow {
  agreementRef: string;
  currency: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

interface OrgWorld {
  /** The acting user's org role, or null for a user with none. */
  role: string | null;
  negotiated: NegotiatedRow | null;
  /** The entitled subscription joined to its plan, or null for none. */
  entitled: (PlanRow & { billingInterval: string }) | null;
}

const FREE_PLAN_WRITTEN = new Date("2026-09-01T00:00:00.000Z");
const SCALE_PLAN_WRITTEN = new Date("2026-08-01T00:00:00.000Z");

/** The seeded Free plan row, at a rate no rate band ever quotes. */
const FREE_PLAN: PlanRow = {
  tier: "free",
  currency: "usd",
  ratePerGauMicros: 5_500n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
  updatedAt: FREE_PLAN_WRITTEN,
};

/** The seeded Scale plan row, at a third distinct rate. */
const SCALE_PLAN: PlanRow & { billingInterval: string } = {
  tier: "scale",
  currency: "usd",
  ratePerGauMicros: 6_250n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 300_000,
  updatedAt: SCALE_PLAN_WRITTEN,
  billingInterval: "month",
};

const NEGOTIATED: NegotiatedRow = {
  agreementRef: "MSA-2026-017",
  currency: "usd",
  ratePerGauMicros: 7_500n,
  blockSizeGau: 10_000,
  includedGauPerMonth: 1_000_000,
  effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
  effectiveTo: null,
};

const { world, scope, key } = vi.hoisted(() => ({
  world: new Map<string, unknown>(),
  scope: { orgId: "" },
  /** The user the API key in these tests was created by, or none. */
  key: { creator: "usr_creator" as string | null },
}));

const PRINCIPAL_ID = "prn_actor";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const here = () => world.get(scope.orgId) as OrgWorld | undefined;
  const rowsFor = (table: unknown, joined: boolean): unknown[] => {
    const w = here();
    if (!w) throw new Error(`no tenant scope entered for ${scope.orgId}`);
    if (table === real.schema.apiKeys)
      return key.creator ? [{ createdById: key.creator }] : [];
    if (table === real.schema.principals) return [{ id: PRINCIPAL_ID }];
    if (table === real.schema.principalRoleAssignments)
      return w.role ? [{ roleName: w.role }] : [];
    if (table === real.schema.contractTerms)
      return w.negotiated ? [w.negotiated] : [];
    if (table === real.schema.subscriptions && joined)
      return w.entitled ? [w.entitled] : [];
    if (table === real.schema.plans) return [FREE_PLAN];
    throw new Error("unexpected table");
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        let joined = false;
        const chain = {
          innerJoin: () => {
            joined = true;
            return chain;
          },
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rowsFor(table, joined)),
        };
        return chain;
      },
    }),
  };
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { ACTION_RATE_BANDS } from "@oxagen/billing";
import { isHandlerError } from "@oxagen/oxagen";
import { billingContractRateGetHandler } from "./billing.contract_rate.get";

// ── helpers ──────────────────────────────────────────────────────────────────

const ORG_NEGOTIATED = "org-negotiated";
const ORG_SELF_SERVE = "org-self-serve";

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

/** Enter `orgId`'s tenant scope and read its rate, as the kernel would. */
async function readRateFor(
  orgId: string,
  userId: string | null = "usr_actor",
  apiKeyId: string | null = null,
) {
  scope.orgId = orgId;
  return billingContractRateGetHandler(
    {},
    ctxFor(orgId, userId, apiKeyId) as Parameters<
      typeof billingContractRateGetHandler
    >[1],
  );
}

beforeEach(() => {
  world.clear();
  key.creator = "usr_creator";
  // Two organisations on the same tier: one with a negotiated agreement in
  // force, one self-serve with none.
  world.set(ORG_NEGOTIATED, {
    role: "Owner",
    negotiated: NEGOTIATED,
    entitled: SCALE_PLAN,
  } satisfies OrgWorld);
  world.set(ORG_SELF_SERVE, {
    role: "Owner",
    negotiated: null,
    entitled: SCALE_PLAN,
  } satisfies OrgWorld);
});

// ── which row answers ────────────────────────────────────────────────────────

describe("get_contract_rate — where the figures come from", () => {
  it("returns the negotiated agreement's rate for the org that holds one", async () => {
    const out = await readRateFor(ORG_NEGOTIATED);
    expect(out.source).toBe("negotiated");
    expect(out.ratePerGauMicros).toBe("7500");
    expect(out.agreementRef).toBe("MSA-2026-017");
    expect(out.blockSizeGau).toBe(10_000);
    expect(out.includedGauPerMonth).toBe(1_000_000);
    expect(out.effectiveFrom).toBe("2026-06-01T00:00:00.000Z");
    expect(out.effectiveTo).toBeNull();
  });

  it("returns the plan's published figures for another org on the same tier with no agreement", async () => {
    const negotiated = await readRateFor(ORG_NEGOTIATED);
    const selfServe = await readRateFor(ORG_SELF_SERVE);

    expect(selfServe.tier).toBe(negotiated.tier);
    expect(selfServe.source).toBe("published_tier");
    expect(selfServe.agreementRef).toBeNull();
    expect(selfServe.ratePerGauMicros).toBe("6250");
    expect(selfServe.includedGauPerMonth).toBe(300_000);
    expect(selfServe.effectiveFrom).toBe(SCALE_PLAN_WRITTEN.toISOString());
    expect(selfServe.effectiveTo).toBeNull();
  });

  it("returns the negotiated end date when the agreement has one", async () => {
    world.set(ORG_NEGOTIATED, {
      role: "Owner",
      negotiated: {
        ...NEGOTIATED,
        effectiveTo: new Date("2027-06-01T00:00:00.000Z"),
      },
      entitled: SCALE_PLAN,
    } satisfies OrgWorld);
    const out = await readRateFor(ORG_NEGOTIATED);
    expect(out.effectiveTo).toBe("2027-06-01T00:00:00.000Z");
  });

  it("falls back to the Free plan for an org with no entitled subscription", async () => {
    world.set(ORG_SELF_SERVE, {
      role: "Owner",
      negotiated: null,
      entitled: null,
    } satisfies OrgWorld);
    const out = await readRateFor(ORG_SELF_SERVE);
    expect(out.tier).toBe("free");
    expect(out.ratePerGauMicros).toBe("5500");
    expect(out.includedGauPerMonth).toBe(5_000);
  });

  it("prints the new tier's rate on the next read after a subscription webhook moves the org from Free to Scale", async () => {
    world.set(ORG_SELF_SERVE, {
      role: "Owner",
      negotiated: null,
      entitled: null,
    } satisfies OrgWorld);
    const onFree = await readRateFor(ORG_SELF_SERVE);
    expect(onFree.tier).toBe("free");
    expect(onFree.ratePerGauMicros).toBe("5500");

    // syncSubscriptionFromStripe rewrites subscriptions.plan_id; nothing
    // copies the tier into the organisation.
    world.set(ORG_SELF_SERVE, {
      role: "Owner",
      negotiated: null,
      entitled: SCALE_PLAN,
    } satisfies OrgWorld);
    const onScale = await readRateFor(ORG_SELF_SERVE);
    expect(onScale.tier).toBe("scale");
    expect(onScale.ratePerGauMicros).toBe("6250");
    expect(onScale.includedGauPerMonth).toBe(300_000);
  });

  it("never prices from ACTION_RATE_BANDS", async () => {
    const bandMicros = ACTION_RATE_BANDS.map((band) =>
      String(band.usdPer1000 * 1_000),
    );
    const rates = [
      (await readRateFor(ORG_NEGOTIATED)).ratePerGauMicros,
      (await readRateFor(ORG_SELF_SERVE)).ratePerGauMicros,
    ];
    expect(rates).toEqual(["7500", "6250"]);
    for (const rate of rates) expect(bandMicros).not.toContain(rate);
  });

  it("carries the rate as a decimal string, never a number", async () => {
    const out = await readRateFor(ORG_NEGOTIATED);
    expect(typeof out.ratePerGauMicros).toBe("string");
  });
});

// ── the role gate (INV-29) ───────────────────────────────────────────────────

describe("get_contract_rate — the role gate", () => {
  it.each(["Owner", "Admin", "Billing"])("allows %s", async (role) => {
    world.set(ORG_SELF_SERVE, {
      role,
      negotiated: null,
      entitled: SCALE_PLAN,
    } satisfies OrgWorld);
    await expect(readRateFor(ORG_SELF_SERVE)).resolves.toMatchObject({
      source: "published_tier",
    });
  });

  it("refuses a Member with HandlerError forbidden", async () => {
    world.set(ORG_SELF_SERVE, {
      role: "Member",
      negotiated: null,
      entitled: SCALE_PLAN,
    } satisfies OrgWorld);
    const err = await readRateFor(ORG_SELF_SERVE).catch((e: unknown) => e);
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
  });

  it("refuses a user with no org role at all", async () => {
    world.set(ORG_SELF_SERVE, {
      role: null,
      negotiated: null,
      entitled: SCALE_PLAN,
    } satisfies OrgWorld);
    const err = await readRateFor(ORG_SELF_SERVE).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
  });

  it("refuses a context with no signed-in user", async () => {
    const err = await readRateFor(ORG_SELF_SERVE, null).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "forbidden", reason: "no_principal" });
  });

  describe("an API-key call acts as the key's creator", () => {
    const readAsKey = () => readRateFor(ORG_SELF_SERVE, null, "aky_1");
    const withRole = (role: string) =>
      world.set(ORG_SELF_SERVE, {
        role,
        negotiated: null,
        entitled: SCALE_PLAN,
      } satisfies OrgWorld);

    it("reads the rate for a creator who is an org Billing user", async () => {
      withRole("Billing");
      await expect(readAsKey()).resolves.toMatchObject({
        source: "published_tier",
      });
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      withRole("Member");
      await expect(readAsKey()).rejects.toMatchObject({
        code: "forbidden",
        reason: "org_role_required",
      });
    });

    it("refuses a key with no creator (negative)", async () => {
      key.creator = null;
      await expect(readAsKey()).rejects.toMatchObject({
        code: "forbidden",
        reason: "no_principal",
      });
    });
  });
});
