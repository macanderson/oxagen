// The role gate reads iam.principal_role_assignments and the key's creator
// from auth.api_keys; the tests decide both. `emitSecurityEvent` is the audit
// row this handler is required to leave.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { costPriceEntryRemove } from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import type { PriceEntry } from "@oxagen/billing";

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
    return "Admin";
  },
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: audit.emitSecurityEvent,
}));

import { createPriceEntryRemoveHandler } from "./cost.price_entry.remove";
import { ctx, SCOPE } from "./spend.test-support";

const NOW = new Date("2026-09-17T12:00:00.000Z");

const closedEntry: PriceEntry = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
  orgId: SCOPE.orgId,
  provider: "anthropic",
  model: "claude-sonnet-5",
  modelAliases: [],
  region: null,
  tokenClass: "output",
  unit: "token",
  currency: "USD",
  microsPerMillion: 12_000_000n,
  effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
  effectiveTo: NOW,
  source: "negotiated",
};

function harness(result: PriceEntry | null = closedEntry) {
  const closeNegotiatedPriceEntry = vi.fn(async () => result);
  return {
    handler: createPriceEntryRemoveHandler({
      closeNegotiatedPriceEntry,
      now: () => NOW,
    }),
    closeNegotiatedPriceEntry,
  };
}

const input = (over: Record<string, unknown> = {}) =>
  costPriceEntryRemove.input.parse({
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenClass: "output",
    ...over,
  });

beforeEach(() => {
  gate.refuse = false;
  gate.keyCreator = "u_key_creator";
  gate.actors = [];
  audit.emitSecurityEvent.mockClear();
});

describe("remove_price_entry", () => {
  it("is refused for a role the gate excludes, and closes nothing", async () => {
    const h = harness();
    gate.refuse = true;
    await expect(h.handler(input(), ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
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

  it("ends the row at the write instant when none is given, and answers it as closed", async () => {
    const h = harness();
    const out = await h.handler(input(), ctx());

    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "output",
      region: null,
      at: NOW,
    });
    expect(out.at).toBe(NOW.toISOString());
    expect(out.closed).toMatchObject({
      id: closedEntry.id,
      // Closed, not deleted: the price it charged is still on the wire.
      microsPerMillion: "12000000",
      effectiveTo: NOW.toISOString(),
      source: "negotiated",
    });
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
    expect(audit.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.plan_changed",
        capability: "remove_price_entry",
        orgId: SCOPE.orgId,
      }),
    );
  });

  it("ends the row at the instant asked for, in the region asked for", async () => {
    const h = harness();
    await h.handler(
      input({ region: "eu-west-1", at: "2026-10-01T00:00:00.000Z" }),
      ctx(),
    );
    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "eu-west-1",
        at: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );
  });

  it("answers null when the organization has already ended that rate, so a retry is safe", async () => {
    const h = harness(null);
    const out = await h.handler(input(), ctx());
    expect(out.closed).toBeNull();
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
    // The request is still the event, whether or not a row was open.
    expect(audit.emitSecurityEvent).toHaveBeenCalledTimes(1);
  });
});
