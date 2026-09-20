import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });
afterAll(() => sql.end());

it("replays missing shared-row policies and remains idempotent", async () => {
  const replay = readFileSync(
    new URL(
      "../atlas/migrations/20260921040000_restore_workspace_nullable_writes.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const rollback = new Error("Roll back policy replay fixture");
  await expect(
    sql.begin(async (tx) => {
      const policies = () => tx`
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_catalog.pg_policies
      WHERE (schemaname, tablename) IN (
        ('billing', 'spend_budgets'), ('billing', 'spend_counters'),
        ('iam', 'principals'), ('iam', 'principal_role_assignments'),
        ('iam', 'authorization_deny_generations'), ('iam', 'emergency_denies'),
        ('iam', 'authorization_decisions'), ('notification', 'notifications'),
        ('security', 'security_events'), ('workspace', 'routing_policy')
      ) ORDER BY schemaname, tablename, policyname
    `;
      const expected = [...(await policies())];
      expect(expected).toHaveLength(30);
      await tx`DROP POLICY tenant_org_shared_read ON billing.spend_budgets`;
      await tx`ALTER POLICY tenant_isolation ON billing.spend_budgets USING (true) WITH CHECK (true)`;
      expect([...(await policies())]).not.toEqual(expected);
      await tx.unsafe(replay);
      expect([...(await policies())]).toEqual(expected);
      await tx.unsafe(replay);
      expect([...(await policies())]).toEqual(expected);
      const [protection] = await tx`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class
      WHERE oid = 'billing.spend_budgets'::regclass
    `;
      expect(protection).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
