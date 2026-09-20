// mandate-role.test.ts — the consequence-role and approver gates.
//
// Guards and their negatives:
//   - loadConsequenceRoles: the stored overrides parsed; unset or malformed
//     → {}
//   - rolesForAllTags: the roles common to every tag, overrides first; no
//     tags → []
//   - assertConsequenceRole: no role common to the tags → forbidden
//     `no_role_covers_all_tags` before any role lookup; otherwise the org
//     roles for the tags are what assertOrgRole is asked for
//   - assertApprover: an empty list asks nothing; a `user:` entry matching
//     the caller's public id passes; a `role:` entry passes through
//     assertOrgRole; a caller matching neither, or with no user, is refused
//     `not_an_approver`; an error other than forbidden propagates
//   - both gates act as the user resolveActingUserId returns: an API key's
//     creator is matched and role-checked; a key with no creator is refused

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  withTenantDb: vi.fn(),
  /** The creator an API key resolves to. */
  keyCreator: null as string | null,
  publicId: null as string | null,
}));

vi.mock("./org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: async (ctx: {
    userId: string | null;
    apiKeyId: string | null;
  }) => ctx.userId ?? (ctx.apiKeyId ? mocks.keyCreator : null),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  assertApprover,
  assertConsequenceRole,
  loadConsequenceRoles,
  rolesForAllTags,
} from "./mandate-role";

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1" as string | null,
  apiKeyId: null as string | null,
};
const KEY_CTX = { ...CTX, userId: null, apiKeyId: "aky_1" };
const reason = (r: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === r;

beforeEach(() => {
  mocks.publicId = null;
  mocks.keyCreator = null;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve(
                  mocks.publicId ? [{ publicId: mocks.publicId }] : [],
                ),
            }),
          }),
        }),
      }),
  );
});

describe("loadConsequenceRoles", () => {
  const txWith = (consequenceRoles: unknown) =>
    ({
      query: {
        workspaces: {
          findFirst: async () =>
            consequenceRoles === undefined ? undefined : { consequenceRoles },
        },
      },
    }) as never;

  it("parses the stored overrides", async () => {
    await expect(
      loadConsequenceRoles(txWith({ moves_money: ["Compliance"] }), "ws_1"),
    ).resolves.toEqual({ moves_money: ["Compliance"] });
  });

  it("reads {} for a missing row or a malformed value", async () => {
    await expect(
      loadConsequenceRoles(txWith(undefined), "ws_1"),
    ).resolves.toEqual({});
    await expect(
      loadConsequenceRoles(txWith({ moves_money: ["Nobody"] }), "ws_1"),
    ).resolves.toEqual({});
  });
});

describe("rolesForAllTags", () => {
  it("keeps the roles every tag names", () => {
    expect(rolesForAllTags(["moves_money"], {})).toEqual(["Owner", "Billing"]);
    expect(rolesForAllTags(["moves_money", "destroys_data"], {})).toEqual([
      "Owner",
    ]);
    expect(
      rolesForAllTags(["moves_money"], { moves_money: ["Compliance"] }),
    ).toEqual(["Compliance"]);
    expect(rolesForAllTags([], {})).toEqual([]);
  });
});

describe("assertConsequenceRole", () => {
  it("asks assertOrgRole for the roles the tags name and returns its role", async () => {
    mocks.assertOrgRole.mockResolvedValue("Billing");
    await expect(assertConsequenceRole(CTX, ["moves_money"], {})).resolves.toBe(
      "Billing",
    );
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      CTX,
      {
        org: ["Owner", "Billing"],
      },
      undefined,
    );
  });

  it("refuses tags with no common role before any lookup", async () => {
    await expect(
      assertConsequenceRole(CTX, ["moves_money", "changes_access"], {
        moves_money: ["Billing"],
        changes_access: ["Compliance"],
      }),
    ).rejects.toSatisfy(reason("no_role_covers_all_tags"));
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });
});

describe("assertApprover", () => {
  it("asks nothing when the rule names no approvers", async () => {
    await expect(assertApprover(CTX, [])).resolves.toBeUndefined();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it("passes a caller whose public id a user: entry names", async () => {
    mocks.publicId = "usr_01abc";
    await expect(
      assertApprover(CTX, ["user:usr_01abc", "role:Billing"]),
    ).resolves.toBeUndefined();
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it("passes a caller holding a role a role: entry names", async () => {
    mocks.publicId = "usr_other";
    mocks.assertOrgRole.mockResolvedValue("Billing");
    await expect(
      assertApprover(CTX, ["user:usr_01abc", "role:Billing"]),
    ).resolves.toBeUndefined();
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(CTX, { org: ["Billing"] });
  });

  it("refuses a caller matching no entry", async () => {
    mocks.assertOrgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await expect(assertApprover(CTX, ["role:Billing"])).rejects.toSatisfy(
      reason("not_an_approver"),
    );
    mocks.publicId = "usr_other";
    await expect(assertApprover(CTX, ["user:usr_01abc"])).rejects.toSatisfy(
      reason("not_an_approver"),
    );
  });

  it("refuses a call with no user before any lookup", async () => {
    await expect(
      assertApprover({ ...CTX, userId: null }, ["role:Owner"]),
    ).rejects.toSatisfy(reason("not_an_approver"));
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it("matches a user: entry against an API key's creator", async () => {
    mocks.keyCreator = "u_1";
    mocks.publicId = "usr_01abc";
    await expect(
      assertApprover(KEY_CTX, ["user:usr_01abc"]),
    ).resolves.toBeUndefined();
  });

  it("refuses an API key with no creator before any lookup (negative)", async () => {
    await expect(assertApprover(KEY_CTX, ["role:Owner"])).rejects.toSatisfy(
      reason("not_an_approver"),
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it("propagates an error that is not a refusal", async () => {
    mocks.assertOrgRole.mockRejectedValue(new Error("pool exhausted"));
    await expect(assertApprover(CTX, ["role:Owner"])).rejects.toThrow(
      "pool exhausted",
    );
  });
});
