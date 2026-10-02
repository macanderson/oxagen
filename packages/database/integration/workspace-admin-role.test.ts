/**
 * Workspace Admin role (#5228)
 *
 * Replays 20261002210000_workspace_admin_role.sql against three orgs created
 * after the migration ran, and proves it:
 *
 *   - gives an org with no workspace Admin role one, system-default, with the
 *     public id bootstrapOrgIAM writes for it;
 *   - keeps an org's existing system Admin role as it is;
 *   - leaves an org whose custom workspace role is named "admin" with that
 *     role alone, and does not fail on it;
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
      "../atlas/migrations/20261002210000_workspace_admin_role.sql",
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

      const role = async (
        key: string,
        org: string,
        scopeKind: "org" | "workspace",
        name: string,
        system: boolean,
      ) => {
        await tx`
          INSERT INTO iam.roles (public_id, org_id, scope_kind, name, is_system_default)
          VALUES (${`t5228_${tag}_${key}`}, ${org}, ${scopeKind}, ${name}, ${system})
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

      // A second run writes nothing.
      await tx.unsafe(migration);
      expect(await readAdmins()).toEqual(admins);
      expect(await countRoles()).toBe(before + 1);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
