import { openPriceCancellation } from "./lib/price-cancellation-token";
import { HandlerError } from "@oxagen/oxagen";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import type { PriceEntry } from "@oxagen/billing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPriceEntryListHandler } from "./cost.price_entry.list";
import { ctx, SCOPE } from "./spend.test-support";

// The role gate reads iam.principal_role_assignments; matches
// cost.price_entry.set.test.ts's pattern for the same gate.
const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: {
    userId: string | null;
    apiKeyId: string | null;
  }) => c.userId ?? c.apiKeyId,
  assertOrgRole: async () => {
    if (gate.refuse)
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Member";
  },
}));
afterEach(() => {
  gate.refuse = false;
  vi.unstubAllEnvs();
});

const NOW = new Date("2026-09-14T15:00:00.000Z");

function entry(over: Partial<PriceEntry> = {}): PriceEntry {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: ["claude-sonnet-5-20260601"],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...over,
  };
}

function harness(entries: PriceEntry[]) {
  const listPriceEntries = vi.fn(async () => entries);
  return {
    handler: createPriceEntryListHandler({ listPriceEntries, now: () => NOW }),
    listPriceEntries,
  };
}

describe("list_price_entries", () => {
  it("is refused for a role the gate excludes, and reads nothing (#3271 P1)", async () => {
    const h = harness([]);
    gate.refuse = true;
    await expect(h.handler({}, ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(h.listPriceEntries).not.toHaveBeenCalled();
  });

  it("lists the book effective now when no instant is given", async () => {
    const h = harness([]);
    const out = await h.handler({}, ctx());
    expect(h.listPriceEntries).toHaveBeenCalledWith({
      at: NOW,
      orgId: SCOPE.orgId,
    });
    expect(out).toEqual({ at: NOW.toISOString(), entries: [] });
    expect(() => costPriceEntryList.output.parse(out)).not.toThrow();
  });

  it("opts a management read into scheduled negotiated rates", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-price-secret-with-32-characters");
    const h = harness([
      entry({
        orgId: SCOPE.orgId,
        source: "negotiated",
        effectiveFrom: new Date("2026-12-01T00:00:00Z"),
      }),
    ]);
    const out = await h.handler({ includeScheduled: true }, ctx());
    expect(h.listPriceEntries).toHaveBeenCalledWith({
      at: NOW,
      orgId: SCOPE.orgId,
      includeScheduled: true,
    });
    expect(out.entries[0]?.effectiveFrom).toBe("2026-12-01T00:00:00.000Z");
    expect(
      openPriceCancellation(out.entries[0]!.cancellationToken!),
    ).toMatchObject({
      id: out.entries[0]!.id,
      orgId: SCOPE.orgId,
      effectiveFrom: out.entries[0]!.effectiveFrom,
    });
    expect(costPriceEntryList.input.parse({})).not.toHaveProperty(
      "includeScheduled",
    );
  });

  it("lists the book effective at the instant asked for", async () => {
    const h = harness([]);
    await h.handler({ at: "2026-08-01T00:00:00.000Z" }, ctx());
    expect(h.listPriceEntries).toHaveBeenCalledWith({
      at: new Date("2026-08-01T00:00:00.000Z"),
      orgId: SCOPE.orgId,
    });
  });

  it("answers each entry with its price as integer micros and its window as instants", async () => {
    const h = harness([
      entry(),
      entry({
        id: "0192d4a8-7c1e-7a00-8000-0000000000e2",
        orgId: SCOPE.orgId,
        source: "negotiated",
        microsPerMillion: 2_500_000n,
        effectiveTo: new Date("2026-12-31T00:00:00.000Z"),
      }),
    ]);
    const out = await h.handler({}, ctx());
    expect(out.entries).toEqual([
      {
        id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
        orgId: null,
        provider: "anthropic",
        model: "claude-sonnet-5",
        modelAliases: ["claude-sonnet-5-20260601"],
        region: null,
        tokenClass: "input_uncached",
        unit: "token",
        currency: "USD",
        microsPerMillion: "3000000",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveTo: null,
        source: "list",
      },
      expect.objectContaining({
        orgId: SCOPE.orgId,
        source: "negotiated",
        microsPerMillion: "2500000",
        effectiveTo: "2026-12-31T00:00:00.000Z",
      }),
    ]);
    expect(() => costPriceEntryList.output.parse(out)).not.toThrow();
  });
});
