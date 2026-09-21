import { sealPriceCancellation } from "./lib/price-cancellation-token";
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

/**
 * The same row, still open — the shape `loadPriceBook` would actually answer
 * BEFORE a close that goes on to produce `closedEntry`. The guard reads the
 * book pre-close, so a harness whose default `result` is `closedEntry` needs
 * this, not `closedEntry` itself, standing in as "the organization's active
 * row" or the guard would find nothing live and never engage.
 */
const openEntry: PriceEntry = { ...closedEntry, effectiveTo: null };

function harness(
  result: PriceEntry | null = closedEntry,
  cancelled: PriceEntry[] = [],
  // The book the guard reads BEFORE the close. Defaults to naming the
  // organization's own row open (`openEntry`) whenever `result` says a close
  // is expected to find and end something — matching what `loadPriceBook`
  // would actually answer at that point — and to empty when `result` is
  // null, since a call with nothing to close names no active row either.
  // Nothing else in the book by default means no fallback once that row is
  // gone.
  book: PriceEntry[] = result ? [openEntry] : [],
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
  it("opens the management token and passes its selected ID to the store", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-price-secret-with-32-characters");
    try {
      const cancellationToken = sealPriceCancellation({
        id: openEntry.id,
        orgId: openEntry.orgId!,
        provider: openEntry.provider,
        model: openEntry.model,
        tokenClass: openEntry.tokenClass,
        region: openEntry.region,
        source: "negotiated",
        effectiveFrom: openEntry.effectiveFrom.toISOString(),
      });
      const h = harness(null, [], [openEntry]);
      await h.handler(input({ cancellationToken }), ctx());
      expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledEntryId: openEntry.id,
          orgId: openEntry.orgId,
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["orgId", "model", "provider", "tokenClass", "region"] as const)(
    "rejects a cancellation token bound to another %s",
    async (field) => {
      vi.stubEnv("BETTER_AUTH_SECRET", "test-price-secret-with-32-characters");
      try {
        const payload = {
          id: openEntry.id,
          orgId: openEntry.orgId!,
          provider: openEntry.provider,
          model: openEntry.model,
          tokenClass: openEntry.tokenClass,
          region: openEntry.region,
          source: "negotiated" as const,
          effectiveFrom: openEntry.effectiveFrom.toISOString(),
          [field]:
            field === "orgId"
              ? "00000000-0000-4000-8000-000000000099"
              : "other",
        };
        const h = harness(null);
        await expect(
          h.handler(
            input({ cancellationToken: sealPriceCancellation(payload) }),
            ctx(),
          ),
        ).rejects.toMatchObject({ reason: "price_cancellation_invalid" });
        expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("passes ID-scoped cancellation without treating the active predecessor as a close", async () => {
    const h = harness(null, [], [openEntry]);
    await h.handler(input({ scheduledEntryId: openEntry.id }), ctx());
    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledEntryId: openEntry.id }),
    );
  });

  it("refuses a scheduled cancellation combined with an end instant", async () => {
    const h = harness();
    await expect(
      h.handler(
        input({ scheduledEntryId: openEntry.id, at: NOW.toISOString() }),
        ctx(),
      ),
    ).rejects.toMatchObject({ reason: "scheduled_cancellation_at" });
    expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
  });

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
    await h.handler(input({ confirmUnpriced: true }), {
      ...ctx(),
      userId: null,
      apiKeyId: "ak_1",
    });
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
    // The book this harness reads names only the organization's own open row
    // and nothing else, so the guard refuses the close unless the caller
    // confirms it.
    const h = harness();
    const out = await h.handler(input({ confirmUnpriced: true }), ctx());

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
    // No list row and no other source in the (empty) book this harness
    // reads back: the class goes unpriced, not list-priced.
    expect(out.fallbackPriced).toBe(false);
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
    expect(audit.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.plan_changed",
        capability: "remove_price_entry",
        orgId: SCOPE.orgId,
      }),
    );
  });

  // The gap the reviewer's fresh evidence named: closing the sole negotiated
  // price for a custom model or class used to close first and only say
  // afterward that nothing now prices it. The guard runs before the close,
  // so the class stays priced (at the rate it already had) until the caller
  // states it means to go unpriced.
  it("refuses to close a rate that would leave the class unpriced, without confirmation", async () => {
    const h = harness();
    await expect(h.handler(input(), ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "price_entry_close_would_unprice",
    });
    expect(h.closeNegotiatedPriceEntry).not.toHaveBeenCalled();
    expect(audit.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("closes the rate anyway once the caller confirms it may go unpriced", async () => {
    const h = harness();
    const out = await h.handler(input({ confirmUnpriced: true }), ctx());
    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledTimes(1);
    expect(out.fallbackPriced).toBe(false);
  });

  // The guard checks the book as it stands before the close, so the row
  // about to close must not count as its own fallback: reading the raw book
  // (own row still open, the harness default) would otherwise resolve to
  // that very row and never refuse.
  it("does not let the row about to close stand in as its own fallback", async () => {
    const h = harness();
    await expect(h.handler(input(), ctx())).rejects.toMatchObject({
      reason: "price_entry_close_would_unprice",
    });
  });

  // A key never negotiated, or already ended, closes nothing — the safe
  // no-op a retry relies on — and must stay that way rather than demand
  // confirmation for a call the guard cannot actually be gating.
  it("does not gate the no-op close on confirmation, and does not refuse it", async () => {
    const h = harness(null);
    const out = await h.handler(input(), ctx());
    expect(out.closed).toBeNull();
    expect(h.closeNegotiatedPriceEntry).toHaveBeenCalledTimes(1);
  });

  // The retry after a lost response: the first call ended the sole negotiated
  // rate for a model nothing else prices, this one closes nothing, and the
  // book that comes back has no row for the class. Reporting `true` here told
  // the CLI the model was list-priced again and let the app navigate away
  // without the unpriced warning, while every frame stayed unpriced. A no-op
  // answers the same question a real close does.
  it("reports the class unpriced when a no-op retry finds nothing pricing it", async () => {
    const h = harness(null, [], []);
    const out = await h.handler(input(), ctx());
    expect(out.closed).toBeNull();
    expect(out.fallbackPriced).toBe(false);
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
  });

  // And the other half: a no-op over a class a list row still prices is
  // list-priced, which is what the retry should say.
  it("reports the class priced when a no-op retry finds a row covering it", async () => {
    const listRow: PriceEntry = {
      ...closedEntry,
      id: "0192d4a8-7c1e-7a00-8000-0000000000e4",
      orgId: null,
      source: "list",
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      effectiveTo: null,
    };
    const h = harness(null, [], [listRow]);
    const out = await h.handler(input(), ctx());
    expect(out.closed).toBeNull();
    expect(out.fallbackPriced).toBe(true);
  });

  // The promise the dialog and the CLI make — "falls back to the list
  // price" — is only true when a list row actually still prices the class.
  it("reads fallbackPriced true when a list row still prices the class, without needing to confirm", async () => {
    const listRow: PriceEntry = {
      ...closedEntry,
      id: "0192d4a8-7c1e-7a00-8000-0000000000e3",
      orgId: null,
      source: "list",
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      effectiveTo: null,
    };
    const h = harness(closedEntry, [], [openEntry, listRow]);
    const out = await h.handler(input(), ctx());
    expect(h.loadPriceBook).toHaveBeenCalledWith({ orgId: SCOPE.orgId });
    expect(out.fallbackPriced).toBe(true);
    expect(() => costPriceEntryRemove.output.parse(out)).not.toThrow();
  });

  // The guard reads the book to learn whether this call has anything live to
  // end; the no-op path reads it a second time, after the close, because the
  // reason nothing closed may be that a concurrent call ended the row, and
  // the guard's copy is the one picture that cannot be trusted then.
  it("reads the book again after a close that closed nothing", async () => {
    const h = harness(null);
    await h.handler(input(), ctx());
    expect(h.loadPriceBook).toHaveBeenCalledTimes(2);
  });

  it("ends the row at the instant asked for, in the region asked for", async () => {
    const h = harness();
    await h.handler(
      input({
        region: "eu-west-1",
        at: "2026-10-01T00:00:00.000Z",
        confirmUnpriced: true,
      }),
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
    const out = await h.handler(input({ confirmUnpriced: true }), ctx());
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
});
