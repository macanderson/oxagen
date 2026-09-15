/**
 * Unit tests for the set_auto_topup handler.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so a refusal below comes from the handler alone (INV-29).
 * The role gate runs for real against a tx double that answers the principal
 * and role-assignment tables; the write is a recording double, so what is
 * asserted about it is what the handler hands it (the context's org, the two
 * fields) and that the stored answer is what comes back. The upsert itself
 * (ON CONFLICT (org_id), the SET naming only its own columns) is asserted in
 * packages/billing/src/billing-settings.test.ts.
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

const ctx = (
  over: {
    orgId?: string;
    userId?: string | null;
    apiKeyId?: string | null;
  } = {},
) => makeCTX({ orgId: ORG, userId: USER, ...over });

/** An API-key call: no signed-in user, the key's id. */
const keyCall = () => ctx({ userId: null, apiKeyId: KEY });

// ── role-gate tx double ───────────────────────────────────────────────────────

/** The user the API key in these tests was created by, and the key. */
const KEY_CREATOR = "0192d4a8-7c1e-7a00-8000-0000000c7ea7";
const KEY = "0192d4a8-7c1e-7a00-8000-0000000a91e1";

/**
 * Answers by the table asked for, so query order does not matter: the API
 * key's creator (`keyCreator`, null for a key with none), the principal and
 * the org role.
 */
function stubRole(
  roleName: string | null,
  keyCreator: string | null = KEY_CREATOR,
) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.apiKeys)
      return keyCreator ? [{ createdByUserId: keyCreator }] : [];
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

/** One org_billing_settings row, reduced to the two columns this handler owns. */
type StoredRow = {
  autoTopupEnabled: boolean;
  autoTopupBlocks: number;
};

function makeStore() {
  const rows = new Map<string, StoredRow>();
  const write: AutoTopupWriter = async (orgId, input) => {
    rows.set(orgId, {
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

  it("saves for an API key whose creator is an org Admin, and records the creator as the actor", async () => {
    stubRole("Admin");
    const store = makeStore();
    const handler = createBillingAutoTopupSetHandler(store.write);

    await expect(
      handler({ enabled: true, blocks: 2 }, keyCall()),
    ).resolves.toEqual({ enabled: true, blocks: 2 });
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: KEY_CREATOR }),
    );
  });

  it.each([
    ["an org Member", "Member", KEY_CREATOR, "org_role_required"],
    ["no creator", "Owner", null, "no_principal"],
  ] as const)(
    "refuses an API key whose creator is %s and writes nothing (negative)",
    async (_label, role, creator, reason) => {
      stubRole(role, creator);
      const store = makeStore();
      const handler = createBillingAutoTopupSetHandler(store.write);

      const err = await handler({ enabled: true, blocks: 1 }, keyCall()).catch(
        (e: unknown) => e,
      );

      expect(isHandlerError(err)).toBe(true);
      expect(err).toMatchObject({ code: "forbidden", reason });
      expect(store.write).not.toHaveBeenCalled();
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
