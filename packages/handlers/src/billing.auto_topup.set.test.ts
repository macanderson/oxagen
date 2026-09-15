/**
 * Unit tests for the set_auto_topup handler.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so a refusal below comes from the handler alone (INV-29).
 * The role gate runs for real against a tx double that answers the principal
 * and role-assignment tables; the write runs against an in-memory settings
 * store that applies the same upsert semantics as the Postgres statement it
 * stands in for — an org with no row gets one, an org with a row keeps its
 * other columns — so the tests assert behaviour rather than a canned reply.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

import {
  createBillingAutoTopupSetHandler,
  type AutoTopupWriter,
} from "./billing.auto_topup.set";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";

const ctx = (over: { orgId?: string; userId?: string | null } = {}) =>
  makeCTX({ orgId: ORG, userId: USER, ...over });

// ── role-gate tx double ───────────────────────────────────────────────────────

/** Answers by the table asked for, so query order does not matter. */
function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

// ── in-memory settings store ──────────────────────────────────────────────────

/** One org_billing_settings row, reduced to what this handler touches. */
type StoredRow = {
  autoTopupEnabled: boolean;
  autoTopupBlocks: number;
  /** A neighbouring column, here to prove the upsert leaves it alone. */
  invoiceGauMax: number;
};

function makeStore(seed: Record<string, StoredRow> = {}) {
  const rows = new Map(Object.entries(seed));
  const write: AutoTopupWriter = async (orgId, input) => {
    const existing = rows.get(orgId);
    rows.set(orgId, {
      invoiceGauMax: existing?.invoiceGauMax ?? 100_000,
      autoTopupEnabled: input.enabled,
      autoTopupBlocks: input.blocks,
    });
    return input;
  };
  return { rows, write: vi.fn(write) };
}

describe("set_auto_topup handler — the role gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["Owner", "Admin"])(
    "lets an org %s save the setting",
    async (role) => {
      stubRole(role);
      const store = makeStore();
      const handler = createBillingAutoTopupSetHandler(store.write);

      const out = await handler({ enabled: true, blocks: 3 }, ctx());

      expect(out).toEqual({ enabled: true, blocks: 3 });
      expect(store.rows.get(ORG)?.autoTopupBlocks).toBe(3);
    },
  );

  it.each(["Member", "Billing", "Viewer"])(
    "refuses an org %s with forbidden and writes nothing",
    async (role) => {
      stubRole(role);
      const store = makeStore();
      const handler = createBillingAutoTopupSetHandler(store.write);

      const err = await handler({ enabled: true, blocks: 1 }, ctx()).catch(
        (e: unknown) => e,
      );

      expect(isHandlerError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("forbidden");
      expect(store.write).not.toHaveBeenCalled();
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it("refuses a context with no signed-in user", async () => {
    stubRole("Owner");
    const store = makeStore();
    const handler = createBillingAutoTopupSetHandler(store.write);

    const err = await handler(
      { enabled: false, blocks: 1 },
      ctx({ userId: null }),
    ).catch((e: unknown) => e);

    expect(isHandlerError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("forbidden");
    expect(store.write).not.toHaveBeenCalled();
  });
});

describe("set_auto_topup handler — the write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubRole("Owner");
  });

  it("creates the row for an org that has no settings row yet", async () => {
    const store = makeStore();
    const handler = createBillingAutoTopupSetHandler(store.write);

    await handler({ enabled: false, blocks: 2 }, ctx());

    expect(store.rows.get(ORG)).toEqual({
      autoTopupEnabled: false,
      autoTopupBlocks: 2,
      invoiceGauMax: 100_000,
    });
  });

  it("leaves the org's other billing columns alone", async () => {
    const store = makeStore({
      [ORG]: {
        autoTopupEnabled: true,
        autoTopupBlocks: 1,
        invoiceGauMax: 250_000,
      },
    });
    const handler = createBillingAutoTopupSetHandler(store.write);

    await handler({ enabled: false, blocks: 7 }, ctx());

    expect(store.rows.get(ORG)).toEqual({
      autoTopupEnabled: false,
      autoTopupBlocks: 7,
      invoiceGauMax: 250_000,
    });
  });

  it("writes to the org the context names, never one the caller could pick", async () => {
    const store = makeStore();
    const handler = createBillingAutoTopupSetHandler(store.write);

    await handler({ enabled: true, blocks: 1 }, ctx());

    expect(store.write).toHaveBeenCalledWith(ORG, {
      enabled: true,
      blocks: 1,
    });
  });

  it("returns the setting as stored rather than as sent", async () => {
    const clamped: AutoTopupWriter = async () => ({
      enabled: true,
      blocks: 100,
    });
    const handler = createBillingAutoTopupSetHandler(clamped);

    await expect(handler({ enabled: true, blocks: 5 }, ctx())).resolves.toEqual(
      { enabled: true, blocks: 100 },
    );
  });

  it("audits the mutation against the acting user and the org", async () => {
    const store = makeStore();
    const handler = createBillingAutoTopupSetHandler(store.write);

    await handler({ enabled: true, blocks: 4 }, ctx());

    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "set_auto_topup",
        orgId: ORG,
        actorUserId: USER,
        outcome: "success",
      }),
    );
  });

  it("does not audit a write that failed", async () => {
    const failing: AutoTopupWriter = async () => {
      throw new Error("constraint violated");
    };
    const handler = createBillingAutoTopupSetHandler(failing);

    await expect(
      handler({ enabled: true, blocks: 1 }, ctx()),
    ).rejects.toThrow();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});
