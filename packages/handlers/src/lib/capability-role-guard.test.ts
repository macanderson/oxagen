/**
 * The contract-derived half of the handler-side role guard (oxagen#2819).
 *
 * The five handlers that call `assertCallerRole` each prove their own refusal
 * in their own test. What is proved here is the part they all share and none of
 * them can show on its own: which `GrantEffect` values actually grant, that the
 * comparison is case-insensitive on both sides, and that a contract granting
 * nothing fails closed with a message naming the contract rather than an empty
 * role list.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  membershipReads: [] as Array<Array<{ role: string }>>,
  systemDbCalls: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) => {
      mocks.systemDbCalls();
      return fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => mocks.membershipReads.shift() ?? [],
            }),
          }),
        }),
      });
    },
  };
});

// assertContractRole's gate runs for real against a role fixture.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("../test-utils/org-role-gate")).orgRoleModule(),
);

const {
  assertCallerRole,
  assertContractRole,
  contractRoleRequirement,
  permittedRoles,
} = await import("./capability-role-guard");
const { resetRoleGate, roleGate } = await import(
  "../test-utils/org-role-gate"
);

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

/** A capability descriptor with only the two fields the guard reads. */
function cap(
  name: string,
  org: Record<string, string>,
  workspace: Record<string, string> = {},
) {
  return {
    name,
    defaultRoles: { org, workspace },
  } as unknown as Parameters<typeof assertCallerRole>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.membershipReads.length = 0;
});

describe("permittedRoles", () => {
  it("keeps only the roles granted 'allow'", () => {
    const p = permittedRoles(
      cap("c", { Owner: "allow", Admin: "deny", Billing: "allow" }),
    );
    expect([...p.org]).toEqual(["owner", "billing"]);
    expect(p.orgNames).toEqual(["Owner", "Billing"]);
  });

  it("does not treat 'require_approval' as a grant", () => {
    // The approval step is read only by the agent tool wrapper, so on the API
    // and MCP surfaces there is nothing to satisfy. Denying is the fail-closed
    // reading until an approval step exists on those surfaces.
    const p = permittedRoles(cap("c", { Owner: "require_approval" }));
    expect(p.org.size).toBe(0);
  });

  it("lowercases, because both role columns are written in both casings", () => {
    const p = permittedRoles(cap("c", { Owner: "allow" }, { Owner: "allow" }));
    expect([...p.org]).toEqual(["owner"]);
    expect([...p.workspace]).toEqual(["owner"]);
  });
});

describe("assertCallerRole", () => {
  const OWNER_ONLY = cap("do_thing", { Owner: "allow" });

  it("allows a caller holding a granted role", async () => {
    mocks.membershipReads.push([{ role: "owner" }]);
    await expect(assertCallerRole(OWNER_ONLY, CTX)).resolves.toBeUndefined();
  });

  it("allows the same role stored TitleCase", async () => {
    mocks.membershipReads.push([{ role: "Owner" }]);
    await expect(assertCallerRole(OWNER_ONLY, CTX)).resolves.toBeUndefined();
  });

  it("refuses a role the contract does not grant", async () => {
    mocks.membershipReads.push([{ role: "admin" }]);
    await expect(assertCallerRole(OWNER_ONLY, CTX)).rejects.toThrow(
      "Forbidden: do_thing requires org Owner",
    );
  });

  it("refuses a caller with no membership row", async () => {
    mocks.membershipReads.push([]);
    await expect(assertCallerRole(OWNER_ONLY, CTX)).rejects.toThrow(
      "Forbidden: do_thing requires org Owner",
    );
  });

  it("falls back to the workspace grant when the org role does not qualify", async () => {
    const c = cap("do_thing", { Owner: "allow" }, { Owner: "allow" });
    mocks.membershipReads.push([{ role: "member" }], [{ role: "owner" }]);
    await expect(assertCallerRole(c, CTX)).resolves.toBeUndefined();
  });

  it("names both scopes when it refuses a contract that grants both", async () => {
    const c = cap("do_thing", { Owner: "allow" }, { Owner: "allow" });
    mocks.membershipReads.push([{ role: "member" }], [{ role: "member" }]);
    await expect(assertCallerRole(c, CTX)).rejects.toThrow(
      "Forbidden: do_thing requires org Owner, or workspace Owner",
    );
  });

  it("skips the workspace read when the capability grants no workspace role", async () => {
    mocks.membershipReads.push([{ role: "member" }]);
    await expect(assertCallerRole(OWNER_ONLY, CTX)).rejects.toThrow();
    expect(mocks.systemDbCalls).toHaveBeenCalledTimes(1);
  });

  // An unscoped capability such as set_data_plane carries no workspace.
  it("skips the workspace read when there is no workspace in scope", async () => {
    const c = cap("do_thing", { Owner: "allow" }, { Owner: "allow" });
    mocks.membershipReads.push([{ role: "member" }]);
    await expect(
      assertCallerRole(c, {
        ...CTX,
        workspaceId: "",
      } as CapabilityContext),
    ).rejects.toThrow();
    expect(mocks.systemDbCalls).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller with no authenticated principal, reading nothing", async () => {
    await expect(
      assertCallerRole(OWNER_ONLY, {
        ...CTX,
        userId: null,
        apiKeyId: null,
      } as CapabilityContext),
    ).rejects.toThrow(
      "Unauthorized: do_thing requires an authenticated principal",
    );
    expect(mocks.systemDbCalls).not.toHaveBeenCalled();
  });

  it("lets an api-key principal through without a membership read", async () => {
    // An api-key principal has no org_users row. Its authority is the `scope`
    // column on auth.api_keys, granted when an Owner or Admin minted the key.
    await expect(
      assertCallerRole(OWNER_ONLY, {
        ...CTX,
        userId: null,
        apiKeyId: "aky_ci",
      } as CapabilityContext),
    ).resolves.toBeUndefined();
    expect(mocks.systemDbCalls).not.toHaveBeenCalled();
  });

  it("refuses a user principal with no org in scope", async () => {
    await expect(
      assertCallerRole(OWNER_ONLY, {
        ...CTX,
        orgId: "",
      } as CapabilityContext),
    ).rejects.toThrow("Forbidden: do_thing requires an org scope");
  });

  it("refuses everyone when the contract grants no role at all", async () => {
    await expect(assertCallerRole(cap("do_thing", {}), CTX)).rejects.toThrow(
      "Forbidden: do_thing grants no role in its contract",
    );
    expect(mocks.systemDbCalls).not.toHaveBeenCalled();
  });
});

describe("contractRoleRequirement", () => {
  it("names the allowed org and workspace roles by IAM name", () => {
    expect(
      contractRoleRequirement(
        cap(
          "c",
          { Owner: "allow", Admin: "allow", Billing: "deny" },
          { Owner: "allow", Member: "require_approval" },
        ),
      ),
    ).toEqual({ org: ["Owner", "Admin"], workspace: ["Owner"] });
  });

  it("leaves the workspace leg out when the contract grants none", () => {
    expect(contractRoleRequirement(cap("c", { Owner: "allow" }))).toEqual({
      org: ["Owner"],
    });
  });
});

describe("assertContractRole", () => {
  const OWNER_ADMIN = cap("do_thing", { Owner: "allow", Admin: "allow" });
  const WITH_WS_OWNER = cap(
    "do_thing",
    { Owner: "allow", Admin: "allow" },
    { Owner: "allow" },
  );

  beforeEach(() => resetRoleGate());

  it("returns the org role that satisfied the contract", async () => {
    roleGate.roles = { org: "Admin" };
    await expect(assertContractRole(OWNER_ADMIN, CTX)).resolves.toBe("Admin");
  });

  it("refuses a workspace Member with HandlerError forbidden", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    const err = await assertContractRole(WITH_WS_OWNER, CTX).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isHandlerError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
  });

  it("passes a workspace role the contract grants", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(assertContractRole(WITH_WS_OWNER, CTX)).resolves.toBe(
      "Owner",
    );
  });

  it("does not pass a workspace role when the contract grants only org roles", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(assertContractRole(OWNER_ADMIN, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("acts as an API key's creator", async () => {
    roleGate.roles = { org: "Owner", keyCreator: "u_creator" };
    await expect(
      assertContractRole(OWNER_ADMIN, {
        ...CTX,
        userId: null,
        apiKeyId: "key_1",
      }),
    ).resolves.toBe("Owner");
  });

  it("refuses a key with no creator as no_principal", async () => {
    roleGate.roles = { org: "Owner", keyCreator: null };
    await expect(
      assertContractRole(OWNER_ADMIN, {
        ...CTX,
        userId: null,
        apiKeyId: "key_1",
      }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
  });

  it("refuses a contract that grants no role, naming it", async () => {
    await expect(
      assertContractRole(cap("nobody", { Owner: "deny" }), CTX),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "nobody grants no role in its contract",
    });
  });
});
