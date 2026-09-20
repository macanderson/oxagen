/**
 * Unit tests for the set_tool_classification handler (spec §6.9 part 1,
 * #2958). Tier-free org; the role gate runs for real against a tx double.
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

import {
  createToolClassificationSetHandler,
  type ToolClassificationDeps,
} from "./tool.classification.set";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const ctx = () => makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });

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

const classification = {
  sideEffect: "irreversible" as const,
  egress: "third_party" as const,
  consequenceTags: ["moves_money"],
  measures: {
    amount: {
      path: "$.amount",
      type: "money" as const,
      currencyPath: "$.currency",
    },
  },
  dataClasses: ["payments"],
};

function deps() {
  const writes: Parameters<ToolClassificationDeps["write"]>[0][] = [];
  const d: ToolClassificationDeps = {
    findVersion: async ({ publicId }) =>
      publicId === "tlv_pay" ? { id: "vid_1", publicId } : null,
    write: async (args) => {
      writes.push(args);
    },
  };
  return { d, writes };
}

beforeEach(() => {
  mocks.emitSecurityEvent.mockReset();
  stubRole("Admin");
});

describe("set_tool_classification", () => {
  it("writes the classification, the risk grade, who, when and why, and records the event", async () => {
    const { d, writes } = deps();
    const out = await createToolClassificationSetHandler(d, () => NOW)(
      {
        toolVersionId: "tlv_pay",
        riskGrade: "critical",
        classification,
        reason: "moves customer funds",
      },
      ctx(),
    );

    expect(out).toEqual({
      toolVersionId: "tlv_pay",
      riskGrade: "critical",
      classification,
      classifiedAt: NOW.toISOString(),
    });
    expect(writes).toEqual([
      {
        orgId: ORG,
        workspaceId: WS,
        versionId: "vid_1",
        riskGrade: "critical",
        classification,
        reason: "moves customer funds",
        userId: USER,
        at: NOW,
      },
    ]);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.classification_changed",
        actorUserId: USER,
        orgId: ORG,
        workspaceId: WS,
        capability: "set_tool_classification",
        outcome: "success",
      }),
    );
  });

  it("an unknown version is not_found and nothing is written", async () => {
    const { d, writes } = deps();
    await expect(
      createToolClassificationSetHandler(d, () => NOW)(
        {
          toolVersionId: "tlv_missing",
          riskGrade: "low",
          classification,
          reason: "x",
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "tool_version_not_found",
    });
    expect(writes).toEqual([]);
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it.each(["Member", "Compliance", null])(
    "refuses a tier-free org member holding %s with forbidden",
    async (role) => {
      stubRole(role);
      const { d, writes } = deps();
      const err = await createToolClassificationSetHandler(d, () => NOW)(
        {
          toolVersionId: "tlv_pay",
          riskGrade: "low",
          classification,
          reason: "x",
        },
        ctx(),
      ).catch((e: unknown) => e);
      expect(isHandlerError(err) && err.code).toBe("forbidden");
      expect(writes).toEqual([]);
    },
  );
});
