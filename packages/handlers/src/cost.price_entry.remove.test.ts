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

/** The organization's open negotiated row, the one a removal closes. */
const negotiatedRow: PriceEntry = { ...closedEntry, effectiveTo: null };

/** The list row underneath it: what the frame falls back to. */
const listRow: PriceEntry = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000f1",
  orgId: null,
  provider: "anthropic",
  model: "claude-sonnet-5",
  modelAliases: [],
  region: null,
  tokenClass: "output",
  unit: "token",
  currency: "USD",
  microsPerMillion: 15_000_000n,
  effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
  effectiveTo: null,
  source: "list",
};

function harness(
  result: PriceEntry | null = closedEntry,
  cancelled: PriceEntry[] = [],
  // The book the check reads. By default the organization's open rate with a
  // list row underneath it, so a removal falls back to something.
  book: PriceEntry[] = [negotiatedRow, listRow],
) {
  const closeNegotiatedPriceEntry = vi.fn(async (args: { at?: Date }) => ({
    // The store answers the instant it used: the caller's, or the write
    // instant it read under its locks.
    at: args.at ?? NOW,
    closed: result,
    cancelled,
  }));
  const loadPriceBook = vi.fn(async () => book);
  return {
    handler: createPriceEntryRemoveHandler({
      closeNegotiatedPriceEntry,
      loadPriceBook,
    }),
    closeNegotiatedPriceEntry,
    loadPriceBook,
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
  plane.resolveDataPlane.mockResolvedValue({
    mode: "shared",
    status: "active",
  });
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

  // The inverse of the mismatch `set` refuses: the close would run on the
  // organisation's plane while the rollup reads the shared one, so the call
  // would report an end that never reached the rate in force.
  it("refuses to end a rate on a plane the price book does not read", async () => {
    const h = harness();
    plane.resolveDataPlane.mockResolvedValue({
      mode: "dedicated",
      status: "active",
    });
    await expect(h.handler(input(), ctx())).rejects.toThrow(
      /dedicated\s+Postgres plane/,
    );
    expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
  });

  it("leaves an omitted instant to the store, and answers the instant the store used", async () => {
    const h = harness();
    const out = await h.handler(input(), ctx());

    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokenClass: "output",
      region: null,
      // Omitted, not defaulted here: the store reads the write instant under
      // its advisory locks, so a removal that waited on a write does not carry
      // a cutoff from before the wait.
      at: undefined,
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

  it("answers the row closed at `at` when the end also cancelled a scheduled correction", async () => {
    const scheduled: PriceEntry = {
      ...closedEntry,
      id: "0192d4a8-7c1e-7a00-8000-0000000000e2",
      effectiveFrom: new Date("2026-11-01T00:00:00.000Z"),
      effectiveTo: null,
    };
    const h = harness(closedEntry, [scheduled]);
    const out = await h.handler(input(), ctx());
    // The contract's `closed` is the row that was in effect; the cancelled
    // correction never priced anything and is carried in the log only.
    expect(out.closed?.id).toBe(closedEntry.id);
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
  });

  it("answers null when the organization has already ended that rate, so a retry is safe", async () => {
    const h = harness(null);
    const out = await h.handler(input(), ctx());
    expect(out.closed).toBeNull();
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
    // The request is still the event, whether or not a row was open.
    expect(audit.emitSecurityEvent).toHaveBeenCalledTimes(1);
  });

  it("names the row the model falls back to", async () => {
    const h = harness();
    const out = await h.handler(input(), ctx());
    expect(out.fallback).toMatchObject({
      id: listRow.id,
      orgId: null,
      microsPerMillion: "15000000",
      source: "list",
    });
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
  });

  // "Falls back to the list price" is only true when a list price exists. For
  // a custom model, or a class no catalog publishes, closing the negotiated
  // row leaves the model unpriced, and an unpriced frame records no cost at
  // all rather than a lower one — so runs silently stop carrying a cost while
  // the contract, the CLI and the dialog all promise a fallback.
  it("refuses to close the last rate that can price a model, and closes nothing", async () => {
    const h = harness(closedEntry, [], [negotiatedRow]);
    await expect(h.handler(input(), ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "price_entry_no_fallback",
    });
    expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
    expect(audit.emitSecurityEvent).not.toHaveBeenCalled();
  });

  // A list row for another class prices nothing this removal touches: the
  // fallback is resolved per token class, as the book is keyed.
  it("refuses when the only list row underneath prices a different token class", async () => {
    const h = harness(
      closedEntry,
      [],
      [negotiatedRow, { ...listRow, tokenClass: "input_uncached" }],
    );
    await expect(h.handler(input(), ctx())).rejects.toMatchObject({
      reason: "price_entry_no_fallback",
    });
    expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
  });

  // The operator who means it says so. The close then runs, and the answer
  // carries a null fallback: from here on the model records no cost.
  it("closes the last rate when the caller acknowledges the model becomes unpriced", async () => {
    const h = harness(closedEntry, [], [negotiatedRow]);
    const out = await h.handler(input({ acknowledgeUnpriced: true }), ctx());
    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledTimes(1);
    expect(out.closed?.id).toBe(closedEntry.id);
    expect(out.fallback).toBeNull();
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
  });

  // Nothing open to close cannot unprice anything, so the no-op retry the
  // contract promises must not turn into a refusal.
  it("does not refuse a removal that closes nothing, whatever lies underneath", async () => {
    const h = harness(null, [], []);
    const out = await h.handler(input(), ctx());
    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledTimes(1);
    expect(out.closed).toBeNull();
    expect(out.fallback).toBeNull();
  });

  // The fallback is read from the same shared plane the rollup reads, and it
  // is read before anything is closed.
  it("reads the book for the calling organization before it closes the row", async () => {
    const h = harness();
    await h.handler(input(), ctx());
    expect(h.loadPriceBook).toHaveBeenCalledWith({ orgId: SCOPE.orgId });
    expect(h.loadPriceBook.mock.invocationCallOrder[0]).toBeLessThan(
      h.closeNegotiatedPriceEntry.mock.invocationCallOrder[0]!,
    );
  });
});
