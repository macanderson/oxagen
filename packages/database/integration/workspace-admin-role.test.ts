/**
 * Workspace Admin role (#5228)
 *
 * Replays 20261003030000_workspace_admin_role.sql against three orgs created
 * after the migration ran, and proves it:
 *
 *   - gives an org with no workspace Admin role one, system-default, with the
 *     public id bootstrapOrgIAM writes for it;
 *   - keeps an org's existing system Admin role as it is;
 *   - leaves an org whose custom workspace role is named "admin" with that
 *     role alone, and does not fail on it;
 *   - gives each system workspace Admin role an allow on get_org_settings and
 *     get_spend_budget, keeps an org's explicit deny, and grants a custom role
 *     nothing;
 *   - writes nothing on a second run.
 *
 * The whole replay runs in one transaction that rolls back.
 *
 * CI: rls-integration job (clean, migrated DB).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });
afterAll(() => sql.end());

/** The public id provisioning and the migration write for one grant. */
function grantPublicId(roleId: string, capability: string): string {
  const hex = createHash("sha256")
    .update(`${roleId}:${capability}`, "utf8")
    .digest("hex");
  return `rlg_${hex.slice(0, 24)}`;
}

const READS = ["get_org_settings", "get_spend_budget"] as const;

/** The public id bootstrapOrgIAM and the migration write for the role. */
function rolePublicId(orgId: string): string {
  const hex = createHash("sha256")
    .update(`${orgId}:workspace:Admin`, "utf8")
    .digest("hex");
  return `rol_${hex.slice(0, 22)}`;
}

type RoleRow = {
  org_id: string;
  public_id: string;
  name: string;
  is_system_default: boolean;
};

it("gives every org the workspace Admin role once, and keeps a role that holds the name", async () => {
  const migration = readFileSync(
    new URL(
      "../atlas/migrations/20261003030000_workspace_admin_role.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const fresh = randomUUID();
  const seeded = randomUUID();
  const custom = randomUUID();
  const orgs = [fresh, seeded, custom];
  const rollback = new Error("Roll back workspace Admin role fixture");

  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await tx`
        INSERT INTO org.organizations
          (id, public_id, name, slug, namespace, plan_type, status, type)
        VALUES
          (${fresh}, ${`t5228_${tag}_a`}, 'Admin role A', ${`t5228a-${tag}`}, ${`a${tag.slice(0, 5)}`}, 'free', 'active', 'business'),
          (${seeded}, ${`t5228_${tag}_b`}, 'Admin role B', ${`t5228b-${tag}`}, ${`b${tag.slice(0, 5)}`}, 'free', 'active', 'business'),
          (${custom}, ${`t5228_${tag}_c`}, 'Admin role C', ${`t5228c-${tag}`}, ${`c${tag.slice(0, 5)}`}, 'free', 'active', 'business')
      `;

      const roleIds = new Map<string, string>();
      const role = async (
        key: string,
        org: string,
        scopeKind: "org" | "workspace",
        name: string,
        system: boolean,
      ) => {
        const id = randomUUID();
        roleIds.set(key, id);
        await tx`
          INSERT INTO iam.roles (id, public_id, org_id, scope_kind, name, is_system_default)
          VALUES (${id}, ${`t5228_${tag}_${key}`}, ${org}, ${scopeKind}, ${name}, ${system})
        `;
      };
      // Each org has the roles an org had before this change.
      for (const [key, org] of [
        ["a", fresh],
        ["b", seeded],
        ["c", custom],
      ] as const) {
        await role(`${key}_org_owner`, org, "org", "Owner", true);
        await role(`${key}_org_admin`, org, "org", "Admin", true);
        await role(`${key}_ws_owner`, org, "workspace", "Owner", true);
        await role(`${key}_ws_member`, org, "workspace", "Member", true);
      }
      // Org B already has the role, as an org created after the change does.
      await role("b_ws_admin", seeded, "workspace", "Admin", true);
      // Org C's custom workspace role took the name first.
      await role("c_custom", custom, "workspace", "admin", false);
      // Org B's own explicit deny on one of the two reads.
      await tx`
        INSERT INTO iam.role_grants (public_id, org_id, role_id, capability_id, effect)
        VALUES (${`t5228_${tag}_deny`}, ${seeded}, ${roleIds.get("b_ws_admin")!}, 'get_spend_budget', 'deny')
      `;

      const readAdmins = () =>
        tx<RoleRow[]>`
          SELECT org_id, public_id, name, is_system_default
          FROM iam.roles
          WHERE org_id IN ${tx(orgs)}
            AND scope_kind = 'workspace'
            AND lower(name) = 'admin'
          ORDER BY public_id
        `;
      const countRoles = async () => {
        const [row] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM iam.roles WHERE org_id IN ${tx(orgs)}
        `;
        return row!.n;
      };
      const readGrants = () =>
        tx<{ org_id: string; role_id: string; capability_id: string; effect: string; public_id: string }[]>`
          SELECT org_id, role_id, capability_id, effect, public_id
          FROM iam.role_grants
          WHERE org_id IN ${tx(orgs)}
          ORDER BY public_id
        `;
      const before = await countRoles();

      await tx.unsafe(migration);
      const admins = await readAdmins();

      // One new row, for org A only.
      expect(await countRoles()).toBe(before + 1);
      const byOrg = new Map(admins.map((r) => [r.org_id, r]));
      expect(admins).toHaveLength(3);
      expect(byOrg.get(fresh)).toEqual({
        org_id: fresh,
        public_id: rolePublicId(fresh),
        name: "Admin",
        is_system_default: true,
      });
      // Org B keeps its own row.
      expect(byOrg.get(seeded)!.public_id).toBe(`t5228_${tag}_b_ws_admin`);
      // Org C keeps its custom role, and gains no system Admin beside it.
      expect(byOrg.get(custom)).toEqual({
        org_id: custom,
        public_id: `t5228_${tag}_c_custom`,
        name: "admin",
        is_system_default: false,
      });

      // Grants: both reads for org A's new role, the missing read for org
      // B's role beside its deny, and nothing for org C's custom role.
      const freshRole = byOrg.get(fresh)!;
      const [freshId] = await tx<{ id: string }[]>`
        SELECT id FROM iam.roles WHERE public_id = ${freshRole.public_id}
      `;
      const grants = await readGrants();
      const seededAdmin = roleIds.get("b_ws_admin")!;
      const expected = [
        ...READS.map((capability) => ({
          org_id: fresh,
          role_id: freshId!.id,
          capability_id: capability,
          effect: "allow",
          public_id: grantPublicId(freshId!.id, capability),
        })),
        {
          org_id: seeded,
          role_id: seededAdmin,
          capability_id: "get_org_settings",
          effect: "allow",
          public_id: grantPublicId(seededAdmin, "get_org_settings"),
        },
        {
          org_id: seeded,
          role_id: seededAdmin,
          capability_id: "get_spend_budget",
          effect: "deny",
          public_id: `t5228_${tag}_deny`,
        },
      ];
      const byPublicId = (a: { public_id: string }, b: { public_id: string }) =>
        a.public_id < b.public_id ? -1 : 1;
      expect([...grants].sort(byPublicId)).toEqual(expected.sort(byPublicId));

      // A second run writes nothing.
      await tx.unsafe(migration);
      expect(await readAdmins()).toEqual(admins);
      expect(await countRoles()).toBe(before + 1);
      expect(await readGrants()).toEqual(grants);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
