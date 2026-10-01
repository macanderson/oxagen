/**
 * Spend ranking grants backfill (#4574 item 4, #4955)
 *
 * Replays 20261001120000_backfill_spend_ranking_grants.sql against an org
 * whose system roles were provisioned before get_operator_ranking,
 * set_operator_pseudonyms, and get_unproductive_spend existed, and proves the
 * backfill: an org Admin gains an allow on the ranking and on the pseudonym
 * setting, an org Member gains neither, every reader of the findings gains
 * the headline, and an explicit deny the org set survives. The kernel's IAM
 * check reads exactly these rows in an Enterprise org, so an Admin with them
 * is admitted and a Member without them falls through to the contract's
 * default deny. The whole replay runs in one transaction that rolls back.
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
const PSEUDONYMS = "set_operator_pseudonyms";
const HEADLINE = "get_unproductive_spend";

/** The public id provisioning and the migration write for one grant. */
function grantPublicId(roleId: string, capability: string): string {
  const hex = createHash("sha256")
    .update(`${roleId}:${capability}`, "utf8")
    .digest("hex");
  return `rlg_${hex.slice(0, 24)}`;
}

it("grants the ranking to org Owners and Admins and the headline to every findings reader", async () => {
  const migration = readFileSync(
    new URL(
      "../atlas/migrations/20261001120000_backfill_spend_ranking_grants.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const org = randomUUID();
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const rollback = new Error("Roll back spend ranking grants fixture");

  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await tx`
        INSERT INTO org.organizations
          (id, public_id, name, slug, namespace, plan_type, status, type)
        VALUES
          (${org}, ${`t4574_${tag}_org`}, 'Ranking grants', ${`t4574-${tag}`}, ${`t${tag.slice(0, 5)}`}, 'free', 'active', 'business')
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
          VALUES (${id}, ${`t4574_${tag}_${key}`}, ${org}, ${scopeKind}, ${name}, ${system})
        `;
      };
      await role("owner", "org", "Owner");
      await role("admin", "org", "Admin");
      await role("billing", "org", "Billing");
      await role("member", "org", "Member");
      await role("wsOwner", "workspace", "Owner");
      await role("wsMember", "workspace", "Member");
      await role("custom", "org", "Spend reviewers", false);

      // The org's own explicit deny on the pseudonym setting for its Admins.
      await tx`
        INSERT INTO iam.role_grants (public_id, org_id, role_id, capability_id, effect)
        VALUES (${`t4574_${tag}_deny`}, ${org}, ${roles.get("admin")!}, ${PSEUDONYMS}, 'deny')
      `;

      await tx.unsafe(migration);
      const read = async () =>
        tx<{ role_id: string; capability_id: string; effect: string; public_id: string }[]>`
          SELECT role_id, capability_id, effect, public_id
          FROM iam.role_grants
          WHERE org_id = ${org}
            AND capability_id IN (${RANKING}, ${PSEUDONYMS}, ${HEADLINE})
          ORDER BY role_id, capability_id
        `;
      const rows = await read();
      const effect = (key: string, capability: string) =>
        rows.find(
          (r) => r.role_id === roles.get(key) && r.capability_id === capability,
        )?.effect ?? null;

      // An Enterprise Admin can call both ranking capabilities.
      expect(effect("admin", RANKING)).toBe("allow");
      expect(effect("owner", RANKING)).toBe("allow");
      expect(effect("owner", PSEUDONYMS)).toBe("allow");
      // The org's explicit deny is kept, not overwritten.
      expect(effect("admin", PSEUDONYMS)).toBe("deny");
      // No other role reads the ranking or sets the pseudonyms.
      for (const key of ["billing", "member", "wsOwner", "wsMember", "custom"]) {
        expect(effect(key, RANKING)).toBeNull();
        expect(effect(key, PSEUDONYMS)).toBeNull();
      }
      // Every reader of the findings reads the headline.
      for (const key of ["owner", "admin", "billing", "member", "wsOwner", "wsMember"])
        expect(effect(key, HEADLINE)).toBe("allow");
      expect(effect("custom", HEADLINE)).toBeNull();

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
