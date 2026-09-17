/**
 * Unit tests for the set_disclosure_grain handler (ADR-064).
 *
 * The role gate runs for real against a tx double answering the principal and
 * role-assignment tables; the writer is a recording double, so what is asserted
 * is what the handler hands it and what it does with the answer: a security
 * event for every change and none for a no-op. The write's SQL is asserted
 * against Postgres in lib/proof.pg.test.ts.
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
  createDisclosureGrainSetHandler,
  type DisclosureGrainWriter,
} from "./evidence.disclosure_grain.set";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const AT = new Date("2026-09-15T09:00:00.000Z");

const ctx = (over: { userId?: string | null; apiKeyId?: string | null } = {}) =>
  makeCTX({
    orgId: ORG,
    workspaceId: WS,
    userId: USER,
    apiKeyId: null,
    ...over,
  });

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

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (isHandlerError(err)) return { code: err.code, reason: err.reason };
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  stubRole("Admin");
});

describe("set_disclosure_grain", () => {
  it("stores the grain an Admin asks for and records the change as a security event", async () => {
    const write = vi.fn<DisclosureGrainWriter>(async () => ({
      previous: "L0",
      grain: "L2",
      changedAt: AT,
      changed: true,
    }));
    const out = await createDisclosureGrainSetHandler(write)(
      { grain: "L2" },
      ctx(),
    );
    expect(write).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      "L2",
      USER,
    );
    expect(out).toEqual({
      grain: "L2",
      previousGrain: "L0",
      changedAt: AT.toISOString(),
    });
    expect(mocks.emitSecurityEvent).toHaveBeenCalledOnce();
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "evidence.disclosure_grain_changed",
        actorUserId: USER,
        orgId: ORG,
        workspaceId: WS,
        capability: "set_disclosure_grain",
        outcome: "success",
      }),
    );
  });

  it("emits nothing when the grain asked for is already in force", async () => {
    const write = vi.fn<DisclosureGrainWriter>(async () => ({
      previous: "L0",
      grain: "L0",
      changedAt: null,
      changed: false,
    }));
    const out = await createDisclosureGrainSetHandler(write)(
      { grain: "L0" },
      ctx(),
    );
    expect(out).toEqual({ grain: "L0", previousGrain: "L0", changedAt: null });
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses an API-key caller before the role gate and the write (negative)", async () => {
    const write = vi.fn<DisclosureGrainWriter>();
    expect(
      await refusal(
        createDisclosureGrainSetHandler(write)(
          { grain: "L3" },
          ctx({ apiKeyId: "aky_worker" }),
        ),
      ),
    ).toEqual({ code: "forbidden", reason: "session_required" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a Member, and a caller with no user (negative)", async () => {
    stubRole("Member");
    const write = vi.fn<DisclosureGrainWriter>();
    expect(
      await refusal(
        createDisclosureGrainSetHandler(write)({ grain: "L1" }, ctx()),
      ),
    ).toEqual({ code: "forbidden", reason: "org_role_required" });
    expect(
      await refusal(
        createDisclosureGrainSetHandler(write)(
          { grain: "L1" },
          ctx({ userId: null }),
        ),
      ),
    ).toEqual({ code: "forbidden", reason: "session_required" });
    expect(write).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});
