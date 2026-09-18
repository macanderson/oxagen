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
const audit = vi.hoisted(() => ({ emitSecurityEvent: vi.fn() }));

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
      now: () => NOW,
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

  it("converts the contract's USD per million to micros and defaults the instant to now", async () => {
    const h = harness();
    const out = await h.handler(input(), ctx());

    expect(h.setNegotiatedPriceEntry).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "input_uncached",
      region: null,
      modelAliases: [],
      // $2.40 per 1M, never a float: the customer types 2.40, the store keeps
      // integer micro-USD.
      microsPerMillion: 2_400_000n,
      effectiveFrom: NOW,
    });
    expect(out.entry.microsPerMillion).toBe("2400000");
    expect(out.closed).toBeNull();
    expect(() => costPriceEntrySet.output.parse(out)).not.toThrow();
  });

  it("passes the instant, region and aliases the caller named", async () => {
    const h = harness();
    await h.handler(
      input({
        region: "eu-west-1",
        modelAliases: ["anthropic/claude-sonnet-5"],
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      }),
      ctx(),
    );
    expect(h.setNegotiatedPriceEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "eu-west-1",
        modelAliases: ["anthropic/claude-sonnet-5"],
        effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
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
