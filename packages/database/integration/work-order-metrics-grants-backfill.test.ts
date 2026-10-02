/**
 * Work order metrics grants backfill (F33, #5087)
 *
 * Replays 20261002080000_backfill_work_order_metrics_grants.sql against an
 * org whose system roles were provisioned before get_work_order_metrics and
 * get_spend_per_merged_pr existed, and proves the backfill: an org Owner and
 * Admin gain the metrics, no other role does, every spend reader gains spend
 * per merged PR, and an explicit deny the org set survives. The kernel's IAM
 * check reads these rows in an Enterprise org. The whole replay runs in one
 * transaction that rolls back.
 *
 * CI: rls-integration job (clean, migrated DB).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });
afterAll(() => sql.end());

const METRICS = "get_work_order_metrics";
const PER_MERGED_PR = "get_spend_per_merged_pr";

/** The public id provisioning and the migration write for one grant. */
function grantPublicId(roleId: string, capability: string): string {
  const hex = createHash("sha256")
    .update(`${roleId}:${capability}`, "utf8")
    .digest("hex");
  return `rlg_${hex.slice(0, 24)}`;
}

it("grants the metrics to org Owners and Admins and spend per merged PR to every spend reader", async () => {
  const migration = readFileSync(
    new URL(
      "../atlas/migrations/20261002080000_backfill_work_order_metrics_grants.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const org = randomUUID();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const rollback = new Error("Roll back work order metrics grants fixture");

  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await tx`
        INSERT INTO org.organizations
          (id, public_id, name, slug, namespace, plan_type, status, type)
        VALUES
          (${org}, ${`tf33_${tag}_org`}, 'Metrics grants', ${`tf33-${tag}`}, ${`m${tag.slice(0, 5)}`}, 'free', 'active', 'business')
      `;
      const roles = new Map<string, string>();
      const role = async (
        key: string,
        scopeKind: "org" | "workspace",
        name: string,
        system = true,
      ) => {
        const id = randomUUID();
        roles.set(key, id);
        await tx`
          INSERT INTO iam.roles (id, public_id, org_id, scope_kind, name, is_system_default)
          VALUES (${id}, ${`tf33_${tag}_${key}`}, ${org}, ${scopeKind}, ${name}, ${system})
        `;
      };
      await role("owner", "org", "Owner");
      await role("admin", "org", "Admin");
      await role("billing", "org", "Billing");
      await role("member", "org", "Member");
      await role("wsOwner", "workspace", "Owner");
      await role("wsMember", "workspace", "Member");
      await role("custom", "org", "Spend reviewers", false);

      // The org's own explicit deny on spend per merged PR for its Members.
      await tx`
        INSERT INTO iam.role_grants (public_id, org_id, role_id, capability_id, effect)
        VALUES (${`tf33_${tag}_deny`}, ${org}, ${roles.get("member")!}, ${PER_MERGED_PR}, 'deny')
      `;

      await tx.unsafe(migration);
      const read = async () =>
        tx<{ role_id: string; capability_id: string; effect: string; public_id: string }[]>`
          SELECT role_id, capability_id, effect, public_id
          FROM iam.role_grants
          WHERE org_id = ${org}
            AND capability_id IN (${METRICS}, ${PER_MERGED_PR})
          ORDER BY role_id, capability_id
        `;
      const rows = await read();
      const effect = (key: string, capability: string) =>
        rows.find(
          (r) => r.role_id === roles.get(key) && r.capability_id === capability,
        )?.effect ?? null;

      expect(effect("owner", METRICS)).toBe("allow");
      expect(effect("admin", METRICS)).toBe("allow");
      for (const key of ["billing", "member", "wsOwner", "wsMember", "custom"])
        expect(effect(key, METRICS)).toBeNull();

      for (const key of ["owner", "admin", "billing", "wsOwner", "wsMember"])
        expect(effect(key, PER_MERGED_PR)).toBe("allow");
      // The org's explicit deny is kept, not overwritten.
      expect(effect("member", PER_MERGED_PR)).toBe("deny");
      expect(effect("custom", PER_MERGED_PR)).toBeNull();

      // Each backfilled row carries the id provisioning would have written.
      for (const row of rows.filter((r) => r.effect === "allow"))
        expect(row.public_id).toBe(grantPublicId(row.role_id, row.capability_id));

      // A second run adds nothing.
      await tx.unsafe(migration);
      expect(await read()).toHaveLength(rows.length);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
