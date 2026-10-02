/**
 * Workspace owner assignments backfill (#5182)
 *
 * Replays 20261002170000_backfill_workspace_owner_assignments.sql against two
 * orgs whose workspace owners hold no IAM assignment, and proves the
 * backfill:
 *
 *   - each workspace_users owner, in either casing, with an active human
 *     principal in the workspace's org gains the workspace Owner role on that
 *     workspace, on that principal;
 *   - a suspended principal, a user with no principal, a user with only an
 *     agent principal, a principal in another org, and a member gain nothing;
 *   - an assignment that exists is kept as it is, a revoked one stays revoked;
 *   - the workspace Owner role gains an allow on get_operator_ranking, and an
 *     org's explicit deny survives;
 *   - a second run writes nothing.
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

const RANKING = "get_operator_ranking";

/** The public id the migration writes for one assignment. */
function assignmentPublicId(
  principalId: string,
  roleId: string,
  workspaceId: string,
): string {
  const hex = createHash("sha256")
    .update(`${principalId}:${roleId}:${workspaceId}`, "utf8")
    .digest("hex");
  return `pra_${hex.slice(0, 22)}`;
}

/** The public id provisioning and the migration write for one grant. */
function grantPublicId(roleId: string, capability: string): string {
  const hex = createHash("sha256")
    .update(`${roleId}:${capability}`, "utf8")
    .digest("hex");
  return `rlg_${hex.slice(0, 24)}`;
}

type Assignment = {
  public_id: string;
  principal_id: string;
  role_id: string;
  org_id: string;
  workspace_id: string;
  assigned_by: string | null;
  created_by_id: string | null;
  deleted: boolean;
};

it("gives every workspace owner with an active principal the workspace Owner role, once", async () => {
  const migration = readFileSync(
    new URL(
      "../atlas/migrations/20261002170000_backfill_workspace_owner_assignments.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const orgA = randomUUID();
  const orgB = randomUUID();
  const rollback = new Error("Roll back workspace owner assignments fixture");

  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await tx`
        INSERT INTO org.organizations
          (id, public_id, name, slug, namespace, plan_type, status, type)
        VALUES
          (${orgA}, ${`t5182_${tag}_a`}, 'Owner backfill A', ${`t5182a-${tag}`}, ${`a${tag.slice(0, 5)}`}, 'free', 'active', 'business'),
          (${orgB}, ${`t5182_${tag}_b`}, 'Owner backfill B', ${`t5182b-${tag}`}, ${`b${tag.slice(0, 5)}`}, 'free', 'active', 'business')
      `;

      const roles = new Map<string, string>();
      const role = async (
        key: string,
        org: string,
        scopeKind: "org" | "workspace",
        name: string,
      ) => {
        const id = randomUUID();
        roles.set(key, id);
        await tx`
          INSERT INTO iam.roles (id, public_id, org_id, scope_kind, name, is_system_default)
          VALUES (${id}, ${`t5182_${tag}_${key}`}, ${org}, ${scopeKind}, ${name}, true)
        `;
      };
      await role("ownerA", orgA, "workspace", "Owner");
      await role("memberA", orgA, "workspace", "Member");
      await role("orgOwnerA", orgA, "org", "Owner");
      await role("ownerB", orgB, "workspace", "Owner");

      const workspaces = new Map<string, string>();
      const workspace = async (key: string, org: string) => {
        const id = randomUUID();
        workspaces.set(key, id);
        await tx`
          INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
          VALUES (${id}, ${`t5182_${tag}_${key}`}, ${org}, ${key}, ${`${key}-${tag}`}, ${key})
        `;
      };
      for (const key of ["w1", "w2", "w3", "w4", "w5", "w6", "w7"])
        await workspace(key, orgA);
      await workspace("x1", orgB);

      const users = new Map<string, string>();
      for (const key of ["u1", "u2", "u3", "u4", "u5", "u6", "u7"])
        users.set(key, randomUUID());
      const principals = new Map<string, string>();
      const principal = async (
        key: string,
        org: string,
        user: string,
        kind: "human" | "agent",
        status: "active" | "suspended",
      ) => {
        const id = randomUUID();
        principals.set(key, id);
        await tx`
          INSERT INTO iam.principals (id, public_id, org_id, kind, display_name, status, parent_user_id)
          VALUES (${id}, ${`t5182_${tag}_${key}`}, ${org}, ${kind}, ${key}, ${status}, ${users.get(user)!})
        `;
      };
      await principal("p1", orgA, "u1", "human", "active");
      // An agent principal shares its creator's parent_user_id.
      await principal("a1", orgA, "u1", "agent", "active");
      await principal("p2", orgA, "u2", "human", "active");
      await principal("p3", orgA, "u3", "human", "suspended");
      await principal("p5", orgA, "u5", "human", "active");
      await principal("a6", orgA, "u6", "agent", "active");
      await principal("q7", orgB, "u7", "human", "active");

      const member = async (ws: string, user: string, memberRole: string) => {
        await tx`
          INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at)
          VALUES (${`t5182_${tag}_${ws}_${user}`}, ${workspaces.get(ws)!}, ${users.get(user)!}, ${memberRole}, now())
        `;
      };
      await member("w1", "u1", "owner");
      await member("w1", "u5", "member");
      // The column is written in both casings.
      await member("w2", "u2", "Owner");
      await member("w3", "u3", "owner");
      await member("w4", "u4", "owner");
      await member("w5", "u1", "owner");
      await member("w6", "u2", "owner");
      await member("w7", "u6", "owner");
      await member("x1", "u7", "owner");
      // u1 has no principal in org B, so owning x1 gives u1 nothing there.
      await member("x1", "u1", "owner");

      // An assignment that already exists, and one that was revoked.
      await tx`
        INSERT INTO iam.principal_role_assignments
          (public_id, principal_id, role_id, org_id, workspace_id)
        VALUES
          (${`t5182_${tag}_pre`}, ${principals.get("p1")!}, ${roles.get("ownerA")!}, ${orgA}, ${workspaces.get("w5")!})
      `;
      await tx`
        INSERT INTO iam.principal_role_assignments
          (public_id, principal_id, role_id, org_id, workspace_id, deleted_at)
        VALUES
          (${`t5182_${tag}_revoked`}, ${principals.get("p2")!}, ${roles.get("ownerA")!}, ${orgA}, ${workspaces.get("w6")!}, now())
      `;
      // Org B's own explicit deny on the ranking for its workspace Owners.
      await tx`
        INSERT INTO iam.role_grants (public_id, org_id, role_id, capability_id, effect)
        VALUES (${`t5182_${tag}_deny`}, ${orgB}, ${roles.get("ownerB")!}, ${RANKING}, 'deny')
      `;

      const readAssignments = () =>
        tx<Assignment[]>`
          SELECT public_id, principal_id, role_id, org_id, workspace_id,
                 assigned_by, created_by_id, deleted_at IS NOT NULL AS deleted
          FROM iam.principal_role_assignments
          WHERE org_id IN (${orgA}, ${orgB})
          ORDER BY public_id
        `;
      const readGrants = () =>
        tx<{ role_id: string; effect: string; public_id: string }[]>`
          SELECT role_id, effect, public_id
          FROM iam.role_grants
          WHERE org_id IN (${orgA}, ${orgB}) AND capability_id = ${RANKING}
          ORDER BY public_id
        `;

      await tx.unsafe(migration);
      const assignments = await readAssignments();
      const key = (a: Assignment) =>
        `${a.principal_id}:${a.role_id}:${a.workspace_id}`;
      const expected = (p: string, r: string, w: string) =>
        `${principals.get(p)!}:${roles.get(r)!}:${workspaces.get(w)!}`;

      // Exactly these five: two new in org A, the existing and the revoked
      // one, and one new in org B.
      expect(assignments.map(key).sort()).toEqual(
        [
          expected("p1", "ownerA", "w1"),
          expected("p2", "ownerA", "w2"),
          expected("p1", "ownerA", "w5"),
          expected("p2", "ownerA", "w6"),
          expected("q7", "ownerB", "x1"),
        ].sort(),
      );

      const written = assignments.filter(
        (a) => !a.public_id.startsWith(`t5182_${tag}_`),
      );
      expect(written).toHaveLength(3);
      for (const a of written) {
        expect(a.public_id).toBe(
          assignmentPublicId(a.principal_id, a.role_id, a.workspace_id),
        );
        expect(a.deleted).toBe(false);
      }
      const byKey = new Map(assignments.map((a) => [key(a), a]));
      const w1 = byKey.get(expected("p1", "ownerA", "w1"))!;
      expect(w1.org_id).toBe(orgA);
      expect(w1.assigned_by).toBe(users.get("u1"));
      expect(w1.created_by_id).toBe(users.get("u1"));
      expect(byKey.get(expected("q7", "ownerB", "x1"))!.org_id).toBe(orgB);
      // The existing row is untouched, and the revoked one stays revoked.
      expect(byKey.get(expected("p1", "ownerA", "w5"))!.public_id).toBe(
        `t5182_${tag}_pre`,
      );
      expect(byKey.get(expected("p2", "ownerA", "w6"))!.deleted).toBe(true);
      // No agent principal holds a role.
      for (const agent of ["a1", "a6"])
        expect(
          assignments.some((a) => a.principal_id === principals.get(agent)),
        ).toBe(false);

      // The workspace Owner role reads the ranking; org B's deny survives.
      const grants = await readGrants();
      expect(grants).toEqual([
        {
          role_id: roles.get("ownerB")!,
          effect: "deny",
          public_id: `t5182_${tag}_deny`,
        },
        {
          role_id: roles.get("ownerA")!,
          effect: "allow",
          public_id: grantPublicId(roles.get("ownerA")!, RANKING),
        },
      ].sort((a, b) => (a.public_id < b.public_id ? -1 : 1)));

      // A second run writes nothing.
      await tx.unsafe(migration);
      expect(await readAssignments()).toEqual(assignments);
      expect(await readGrants()).toEqual(grants);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
