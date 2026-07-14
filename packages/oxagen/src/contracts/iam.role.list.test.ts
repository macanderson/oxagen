import { describe, expect, it } from "vitest";
import { iamRoleList } from "./iam.role.list";
import { getCapability } from "../registry";

describe("iam.role.list capability", () => {
  it("is registered under its name with the iam domain", () => {
    const cap = getCapability("list_iam_roles");
    expect(cap).toBeDefined();
    expect(iamRoleList.domain).toBe("iam");
    expect(iamRoleList.mode).toBe("sync");
  });

  it("is read-only, deny-by-default, medium-sensitivity, admin+compliance-gated", () => {
    expect(iamRoleList.scoped).toBe(true);
    expect(iamRoleList.noBillingGate).toBe(true);
    expect(iamRoleList.defaultEffect).toBe("deny");
    expect(iamRoleList.sensitivity).toBe("medium");
    expect(iamRoleList.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
    });
    // Org-scoped surface: no workspace-role default grants.
    expect(iamRoleList.defaultRoles.workspace).toEqual({});
  });

  it("declares the app layer (UI parity promise)", () => {
    expect(iamRoleList.layers).toEqual(expect.arrayContaining(["app"]));
  });

  it("defaults includeGrants=true, limit=100, offset=0", () => {
    const parsed = iamRoleList.input.parse({});
    expect(parsed.includeGrants).toBe(true);
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(0);
  });

  it("only accepts known scope kinds", () => {
    expect(iamRoleList.input.parse({ scopeKind: "org" }).scopeKind).toBe("org");
    expect(() => iamRoleList.input.parse({ scopeKind: "global" })).toThrow();
  });

  it("enforces limit bounds (1–200)", () => {
    expect(() => iamRoleList.input.parse({ limit: 0 })).toThrow();
    expect(() => iamRoleList.input.parse({ limit: 201 })).toThrow();
  });

  it("parses a valid output with grants", () => {
    const parsed = iamRoleList.output.parse({
      roles: [
        {
          id: "rol_abc",
          name: "Owner",
          description: null,
          scopeKind: "org",
          isSystemDefault: true,
          version: "1",
          memberCount: 2,
          grants: [{ capability: "query_audit_log", effect: "allow" }],
        },
      ],
      total: 1,
      hasMore: false,
      limit: 100,
      offset: 0,
    });
    expect(parsed.roles[0]?.grants[0]?.effect).toBe("allow");
  });

  it("rejects an output grant with an invalid effect", () => {
    expect(() =>
      iamRoleList.output.parse({
        roles: [
          {
            id: "rol_abc",
            name: "Owner",
            description: null,
            scopeKind: "org",
            isSystemDefault: true,
            version: "1",
            memberCount: 0,
            grants: [{ capability: "x", effect: "sometimes" }],
          },
        ],
        total: 1,
        hasMore: false,
        limit: 100,
        offset: 0,
      }),
    ).toThrow();
  });
});
