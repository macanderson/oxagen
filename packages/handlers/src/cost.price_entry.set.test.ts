// The role gate reads iam.principal_role_assignments and the key's creator
// from auth.api_keys; the tests decide both. `emitSecurityEvent` is the
// audit row this handler is required to leave.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import type { NegotiatedPriceWrite, PriceEntry } from "@oxagen/billing";

const gate = vi.hoisted(() => ({
  refuse: false,
  keyCreator: "u_key_creator" as string | null,
  actors: [] as (string | null)[],
}));
const audit = vi.hoisted(() => ({ emitSecurityEvent: vi.fn(), info: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info: audit.info, error: vi.fn() } }));
const plane = vi.hoisted(() => ({ resolveDataPlane: vi.fn() }));

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return { ...real, resolveDataPlane: plane.resolveDataPlane };
});

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: {
    userId: string | null;
    apiKeyId: string | null;
  }) => c.userId ?? (c.apiKeyId ? gate.keyCreator : null),
  assertOrgRole: async (actor: { userId: string | null }) => {
    gate.actors.push(actor.userId);
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    if (gate.refuse)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Billing";
  },
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: audit.emitSecurityEvent,
}));

import { createPriceEntrySetHandler } from "./cost.price_entry.set";
import { ctx, SCOPE } from "./spend.test-support";

const NOW = new Date("2026-09-17T12:00:00.000Z");

function entry(over: Partial<PriceEntry> = {}): PriceEntry {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
    orgId: SCOPE.orgId,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 2_400_000n,
    effectiveFrom: NOW,
    effectiveTo: null,
    source: "negotiated",
    ...over,
  };
}

function harness(result?: NegotiatedPriceWrite) {
  const setNegotiatedPriceEntry = vi.fn(
    async (): Promise<NegotiatedPriceWrite> =>
      result ?? { entry: entry(), closed: null },
  );
  return {
    handler: createPriceEntrySetHandler({
      setNegotiatedPriceEntry,
    }),
    setNegotiatedPriceEntry,
  };
}

const input = (over: Record<string, unknown> = {}) =>
  costPriceEntrySet.input.parse({
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenClass: "input_uncached",
    usdPerMillion: 2.4,
    ...over,
  });

beforeEach(() => {
  // Every organisation is shared today (ADR-042 §1); `status` matters because
  // assertDataPlaneUsable refuses any binding that is not active.
  plane.resolveDataPlane.mockResolvedValue({
    mode: "shared",
    status: "active",
  });
  gate.refuse = false;
  gate.keyCreator = "u_key_creator";
  gate.actors = [];
  audit.emitSecurityEvent.mockClear();
});

describe("set_price_entry", () => {
  it("is refused for a role the gate excludes, and writes nothing", async () => {
    const h = harness();
    gate.refuse = true;
    await expect(h.handler(input(), ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(h.setNegotiatedPriceEntry).not.toHaveBeenCalled();
    expect(audit.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("gates an API-key call on the key's creator, not on the absent session user", async () => {
    const h = harness();
    gate.keyCreator = null;
    await expect(
      h.handler(input(), { ...ctx(), userId: null, apiKeyId: "ak_1" }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });

    gate.keyCreator = "u_key_creator";
    await h.handler(input(), { ...ctx(), userId: null, apiKeyId: "ak_1" });
    expect(gate.actors).toEqual([null, "u_key_creator"]);
  });

  it("converts the contract's USD per million to micros and leaves an omitted instant to the store", async () => {
    const h = harness();
    const out = await h.handler(input(), ctx());

    expect(h.setNegotiatedPriceEntry).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
      region: null,
      // `undefined`, NOT `[]`. Both the app and the CLI omit this field when
      // the operator types no aliases, and coercing it to an empty array made
      // every price correction silently erase the stored alias list, after
      // which frames arriving under those names stopped being priced at all.
      modelAliases: undefined,
      // $2.40 per 1M, never a float: the customer types 2.40, the store keeps
      // integer micro-USD.
      microsPerMillion: 2_400_000n,
      // Omitted, not defaulted here: the store reads the write instant under
      // its advisory locks, because a clock sampled before the lock wait is
      // stale by the time the shipped-window check runs. The instant the
      // store used comes back on the entry.
      effectiveFrom: undefined,
    });
    expect(out.entry.effectiveFrom).toBe(NOW.toISOString());
    expect(out.entry.microsPerMillion).toBe("2400000");
    expect(out.closed).toBeNull();
    expect(() => costPriceEntrySet.output.parse(out)).not.toThrow();
  });

  it("passes the instant and the aliases the caller named", async () => {
    const h = harness();
    await h.handler(
      input({
        modelAliases: ["anthropic/claude-sonnet-5"],
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      }),
      ctx(),
    );
    expect(h.setNegotiatedPriceEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        modelAliases: ["anthropic/claude-sonnet-5"],
        effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
  });

  // An explicit empty list is a real instruction — "this model has no aliases"
  // — and must not be confused with omission.
  it("keeps an explicit empty alias list distinct from omission", async () => {
    const h = harness();
    await h.handler(input({ modelAliases: [] }), ctx());
    expect(h.setNegotiatedPriceEntry).toHaveBeenCalledWith(
      expect.objectContaining({ modelAliases: [] }),
    );
  });

  // `resolvePriceEntry` never reads `PriceEntry.region` and a frame does not
  // record the region it was served from, so a regional row would simply be a
  // candidate everywhere.
  it("refuses a region-specific rate while nothing resolves by region", async () => {
    const h = harness();
    await expect(
      h.handler(input({ region: "eu-west-1" }), ctx()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "price_entry_region_unsupported",
    });
    expect(h.setNegotiatedPriceEntry).not.toHaveBeenCalled();
  });

  // The write is `withTenantDb` (the org's plane) and `loadPriceBook` is
  // `withSystemDb` (always shared). On a dedicated plane those are different
  // databases, so the rate would be stored where the rollup never looks.
  it("refuses to write a rate the price book could never read", async () => {
    const h = harness();
    plane.resolveDataPlane.mockResolvedValue({
      mode: "dedicated",
      status: "active",
    });
    await expect(h.handler(input(), ctx())).rejects.toThrow(
      /dedicated\s+Postgres plane/,
    );
    expect(h.setNegotiatedPriceEntry).not.toHaveBeenCalled();
  });

  it("answers the row it superseded, and audits the change", async () => {
    const superseded = entry({
      id: "0192d4a8-7c1e-7a00-8000-0000000000e0",
      microsPerMillion: 3_000_000n,
      effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
      effectiveTo: NOW,
    });
    const h = harness({ entry: entry(), closed: superseded });
    const out = await h.handler(input(), ctx());

    expect(out.closed).toMatchObject({
      id: superseded.id,
      microsPerMillion: "3000000",
      effectiveTo: NOW.toISOString(),
    });
    expect(() => costPriceEntrySet.output.parse(out)).not.toThrow();

    // SOC 2 CC6.3: this moved the organization's commercial terms.
    expect(audit.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.plan_changed",
        capability: "set_price_entry",
        orgId: SCOPE.orgId,
        outcome: "success",
      }),
    );
  });
});

describe("atomic rate card", () => {
  it("submits all classes in one store call and audits only committed cards", async () => {
    const setNegotiatedPriceEntry = vi.fn();
    const setNegotiatedPriceCard = vi.fn().mockResolvedValue([
      { entry: entry(), closed: null },
      {
        entry: entry({ tokenClass: "output", microsPerMillion: 15_000_000n }),
        closed: entry({ tokenClass: "output", microsPerMillion: 20_000_000n }),
      },
    ]);
    const handler = createPriceEntrySetHandler({
      setNegotiatedPriceEntry,
      setNegotiatedPriceCard,
    });
    const card = input({
      additionalRates: [{ tokenClass: "output", usdPerMillion: 15 }],
    });
    const result = await handler(card, ctx());
    expect(setNegotiatedPriceEntry).not.toHaveBeenCalled();
    expect(setNegotiatedPriceCard).toHaveBeenCalledOnce();
    expect(setNegotiatedPriceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: SCOPE.orgId,
        rates: [
          { tokenClass: "input_uncached", microsPerMillion: 2_400_000n },
          { tokenClass: "output", microsPerMillion: 15_000_000n },
        ],
      }),
    );
    expect(result.additionalEntries?.[0]?.entry.tokenClass).toBe("output");
    expect(audit.info).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalRates: [
          {
            tokenClass: "output",
            microsPerMillion: "15000000",
            previousMicrosPerMillion: "20000000",
          },
        ],
      }),
      expect.any(String),
    );
    audit.emitSecurityEvent.mockClear();
    setNegotiatedPriceCard.mockRejectedValue(new Error("second class refused"));
    await expect(handler(card, ctx())).rejects.toThrow("second class refused");
    expect(audit.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a repeated primary class before any mutation", async () => {
    const setNegotiatedPriceEntry = vi.fn();
    const setNegotiatedPriceCard = vi.fn();
    const handler = createPriceEntrySetHandler({
      setNegotiatedPriceEntry,
      setNegotiatedPriceCard,
    });
    await expect(
      handler(
        input({
          additionalRates: [{ tokenClass: "input_uncached", usdPerMillion: 3 }],
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "duplicate_price_class",
    });
    expect(setNegotiatedPriceEntry).not.toHaveBeenCalled();
    expect(setNegotiatedPriceCard).not.toHaveBeenCalled();
  });
});
