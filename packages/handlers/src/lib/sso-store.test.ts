import { describe, expect, it } from "vitest";
import { schema, type Tx } from "@oxagen/database";
import {
  countVerifiedOrgSsoProviders,
  deleteOrgSsoProvider,
  findOrgSsoProvider,
  insertOrgSsoProvider,
  listOrgSsoGroupRoles,
  readOrgSsoRequired,
  replaceOrgSsoGroupRoles,
  updateOrgSsoProvider,
  upsertOrgSsoRequired,
} from "./sso-store";

/**
 * A Drizzle chain double. Every method call is recorded and returns the
 * chain; awaiting the chain resolves to the next queued result. Enough to
 * check which table each query touches, what it writes, and that it returns
 * what the query returned.
 */
function fakeTx(results: unknown[]) {
  const calls: Array<[string, unknown[]]> = [];
  const make = (): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === "then") {
          const value = results.shift();
          return (resolve: (v: unknown) => void) => resolve(value);
        }
        return (...args: unknown[]) => {
          calls.push([String(prop), args]);
          return make();
        };
      },
    });
  const names = () => calls.map(([name]) => name);
  const argsOf = (name: string) => calls.find(([n]) => n === name)?.[1];
  return { tx: make() as Tx, calls, names, argsOf };
}

const ORG = "org_1";

describe("sso-store", () => {
  it("finds one provider, or null", async () => {
    const hit = fakeTx([[{ providerId: "acme" }]]);
    await expect(findOrgSsoProvider(hit.tx, ORG, "acme")).resolves.toEqual({
      providerId: "acme",
    });
    expect(hit.argsOf("from")).toEqual([schema.ssoProviderTable]);
    expect(hit.names()).toContain("limit");

    const miss = fakeTx([[]]);
    await expect(findOrgSsoProvider(miss.tx, ORG, "acme")).resolves.toBeNull();
  });

  it("lists group roles only when there are providers to list them for", async () => {
    const none = fakeTx([]);
    await expect(listOrgSsoGroupRoles(none.tx, ORG, [])).resolves.toEqual([]);
    expect(none.calls).toEqual([]);

    const rows = [{ providerId: "acme", idpGroup: "eng", role: "member" }];
    const some = fakeTx([rows]);
    await expect(listOrgSsoGroupRoles(some.tx, ORG, ["acme"])).resolves.toBe(
      rows,
    );
    expect(some.argsOf("from")).toEqual([schema.ssoGroupRoles]);
  });

  it("reads the SSO requirement, defaulting to false with no policy row", async () => {
    await expect(
      readOrgSsoRequired(fakeTx([[{ ssoRequired: true }]]).tx, ORG),
    ).resolves.toBe(true);
    await expect(readOrgSsoRequired(fakeTx([[]]).tx, ORG)).resolves.toBe(false);
  });

  it("counts verified providers as a number", async () => {
    await expect(
      countVerifiedOrgSsoProviders(fakeTx([[{ n: "2" }]]).tx, ORG),
    ).resolves.toBe(2);
    await expect(
      countVerifiedOrgSsoProviders(fakeTx([[]]).tx, ORG),
    ).resolves.toBe(0);
  });

  it("inserts a provider and refuses a write that returned nothing", async () => {
    const ok = fakeTx([[{ providerId: "acme" }]]);
    await expect(
      insertOrgSsoProvider(ok.tx, {
        providerId: "acme",
      } as typeof schema.ssoProviderTable.$inferInsert),
    ).resolves.toEqual({ providerId: "acme" });
    expect(ok.argsOf("insert")).toEqual([schema.ssoProviderTable]);

    await expect(
      insertOrgSsoProvider(
        fakeTx([[]]).tx,
        {} as typeof schema.ssoProviderTable.$inferInsert,
      ),
    ).rejects.toThrow(/not stored/);
  });

  it("stamps updatedAt on an update", async () => {
    const t = fakeTx([[{ providerId: "acme" }]]);
    await updateOrgSsoProvider(t.tx, ORG, "acme", { displayName: "A" });
    const [set] = t.argsOf("set") as [Record<string, unknown>];
    expect(set["displayName"]).toBe("A");
    expect(set["updatedAt"]).toBeInstanceOf(Date);
    await expect(
      updateOrgSsoProvider(fakeTx([[]]).tx, ORG, "acme", {}),
    ).resolves.toBeNull();
  });

  it("deletes a provider and returns what was deleted", async () => {
    const t = fakeTx([[{ providerId: "acme" }]]);
    await expect(deleteOrgSsoProvider(t.tx, ORG, "acme")).resolves.toEqual({
      providerId: "acme",
    });
    expect(t.argsOf("delete")).toEqual([schema.ssoProviderTable]);
    await expect(
      deleteOrgSsoProvider(fakeTx([[]]).tx, ORG, "acme"),
    ).resolves.toBeNull();
  });

  it("upserts only the SSO column and the audit stamps, keeping the MFA columns", async () => {
    const t = fakeTx([undefined]);
    await upsertOrgSsoRequired(t.tx, ORG, true, "u_1");
    expect(t.argsOf("insert")).toEqual([schema.orgSecurityPolicy]);
    expect(t.argsOf("values")).toEqual([
      { orgId: ORG, ssoRequired: true, updatedById: "u_1" },
    ]);
    const [conflict] = t.argsOf("onConflictDoUpdate") as [
      { target: unknown; set: Record<string, unknown> },
    ];
    expect(conflict.target).toBe(schema.orgSecurityPolicy.orgId);
    expect(Object.keys(conflict.set).sort()).toEqual([
      "ssoRequired",
      "updatedAt",
      "updatedById",
    ]);
  });

  it("replaces a provider's group roles: delete, then insert the new rows", async () => {
    const t = fakeTx([undefined, undefined]);
    await replaceOrgSsoGroupRoles(
      t.tx,
      ORG,
      "acme",
      [{ group: "eng", role: "member" }],
      "u_1",
    );
    expect(t.names().filter((n) => n === "delete" || n === "insert")).toEqual([
      "delete",
      "insert",
    ]);
    expect(t.argsOf("values")).toEqual([
      [
        {
          orgId: ORG,
          providerId: "acme",
          idpGroup: "eng",
          role: "member",
          createdById: "u_1",
          updatedById: "u_1",
        },
      ],
    ]);
  });

  it("clears the table without an empty insert", async () => {
    const t = fakeTx([undefined]);
    await replaceOrgSsoGroupRoles(t.tx, ORG, "acme", [], null);
    expect(t.names()).toContain("delete");
    expect(t.names()).not.toContain("insert");
  });
});
