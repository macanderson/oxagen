import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 2, prepare: false });
const rollback = new Error("Roll back audit partition fixture");
afterAll(() => sql.end());

describe("audit partition maintenance", () => {
  it("restores the partitioned parent and limits function authority", async () => {
    const [parent] =
      await sql`SELECT relkind FROM pg_catalog.pg_class WHERE oid = 'security.security_events'::regclass`;
    expect(parent?.relkind).toBe("p");
    const checks = await sql`
      SELECT conrelid::regclass::text AS relation, convalidated, pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint
      WHERE conrelid IN ('security.security_events'::regclass, 'security.security_events_default'::regclass)
        AND conname = 'security_events_event_type_check'
      ORDER BY conrelid::regclass::text
    `;
    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.convalidated === false)).toBe(true);
    expect(checks[0]?.definition).toBe(checks[1]?.definition);

    const [definition] = await sql`
      SELECT p.prosecdef, p.proconfig, pg_has_role('oxagen_app', p.proowner, 'MEMBER') AS app_can_assume_owner,
        has_function_privilege('oxagen_app', p.oid, 'EXECUTE') AS app_can_execute,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_can_execute
      FROM pg_catalog.pg_proc p WHERE p.oid = 'security.maintain_audit_partitions()'::regprocedure
    `;
    expect(definition).toMatchObject({
      prosecdef: true,
      app_can_assume_owner: false,
      app_can_execute: true,
      public_can_execute: false,
    });
    expect(definition?.proconfig).toContain("search_path=pg_catalog, pg_temp");
    const [helper] =
      await sql`SELECT has_function_privilege('oxagen_app', 'security.copy_audit_table_security(regclass,regclass,boolean)', 'EXECUTE') AS allowed`;
    expect(helper?.allowed).toBe(false);
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE oxagen_app`;
        await tx`CREATE TABLE security.arbitrary_app_ddl (id integer)`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE oxagen_app`;
        await tx`SELECT security.maintain_audit_partitions('2099-01-01'::timestamptz)`;
      }),
    ).rejects.toMatchObject({ code: "42883" });
  });

  it("preserves current DEFAULT rows, expires calendar-old rows, and holds the cross-process lock", async () => {
    const org = randomUUID();
    const currentId = randomUUID();
    const expiredId = randomUUID();
    const retainedId = randomUUID();
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
        // The fixture owns all DDL in this transaction and rolls it back.
        const children =
          await tx`SELECT c.oid::regclass::text AS name FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'security.security_events'::regclass AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'`;
        for (const child of children) {
          await tx.unsafe(
            `ALTER TABLE security.security_events DETACH PARTITION ${child.name}`,
          );
        }
        await tx`INSERT INTO security.security_events(id, org_id, occurred_at, event_type, outcome) VALUES
        (${currentId}, ${org}, CURRENT_TIMESTAMP, 'capability.invoke_allowed', 'allow'),
        (${expiredId}, ${org}, ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '7 years 1 second') AT TIME ZONE 'UTC', 'capability.invoke_allowed', 'allow'),
        (${retainedId}, ${org}, ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '7 years') AT TIME ZONE 'UTC', 'capability.invoke_allowed', 'allow')`;
        // Detached current-month names would deliberately fail the name guard.
        // Rename them within this rolled-back fixture before maintenance.
        for (const child of children) {
          const replacement = `audit_fixture_${randomUUID().replaceAll("-", "")}`;
          await tx.unsafe(`ALTER TABLE ${child.name} RENAME TO ${replacement}`);
        }
        const [old] =
          await tx`SELECT to_char(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '8 years', 'YYYY_MM') AS suffix,
        ((date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '8 years') AT TIME ZONE 'UTC')::text AS lower,
        ((date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '8 years' + interval '1 month') AT TIME ZONE 'UTC')::text AS upper`;
        const expiredPartition = `security_events_${old!.suffix}`;
        await tx.unsafe(
          `CREATE TABLE security.${expiredPartition} PARTITION OF security.security_events FOR VALUES FROM ('${old!.lower}') TO ('${old!.upper}')`,
        );
        await tx`INSERT INTO security.security_events(org_id, occurred_at, event_type, outcome)
        VALUES (${org}, ${old!.lower}::timestamptz, 'capability.invoke_allowed', 'allow')`;
        // Exercise the definer body without superuser privilege. All ownership,
        // grants, and the fixture role disappear with this transaction rollback.
        const owner = `audit_owner_${randomUUID().replaceAll("-", "")}`;
        await tx.unsafe(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA security TO ${owner}`);
        await tx.unsafe(
          `ALTER TABLE security.security_events OWNER TO ${owner}`,
        );
        await tx.unsafe(
          `ALTER TABLE security.security_events_default OWNER TO ${owner}`,
        );
        await tx.unsafe(
          `ALTER TABLE security.${expiredPartition} OWNER TO ${owner}`,
        );
        await tx.unsafe(
          `GRANT EXECUTE ON FUNCTION security.copy_audit_table_security(regclass,regclass,boolean) TO ${owner}`,
        );
        await tx.unsafe(
          `ALTER FUNCTION security.maintain_audit_partitions() OWNER TO ${owner}`,
        );
        const [ownerFlags] =
          await tx`SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = ${owner}`;
        expect(ownerFlags).toMatchObject({
          rolsuper: false,
          rolbypassrls: false,
        });
        await tx`SET LOCAL ROLE oxagen_app`;
        await tx`CREATE TEMP TABLE pg_class (oid oid, relkind "char") ON COMMIT DROP`;
        await tx`SELECT set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', ${org}, true), set_config('app.current_workspace_id', ${currentId}, true)`;
        const [first] =
          await tx`SELECT security.maintain_audit_partitions() AS result`;
        const [afterMaintenance] =
          await tx`SELECT current_setting('app.rls_bypass') AS bypass, current_setting('app.current_org_id') AS org, current_setting('app.current_workspace_id') AS workspace`;
        expect(afterMaintenance).toMatchObject({
          bypass: "off",
          org,
          workspace: currentId,
        });
        expect(first?.result.created).toHaveLength(3);
        expect(first?.result.dropped).toContain(expiredPartition);
        expect(first?.result.expiredDefaultRows).toBeGreaterThanOrEqual(1);
        const [lock] = await sql.begin(
          async (other) =>
            other`SELECT pg_try_advisory_xact_lock(1869768558, 2840) AS acquired`,
        );
        expect(lock?.acquired).toBe(false);
        const [second] =
          await tx`SELECT security.maintain_audit_partitions() AS result`;
        expect(second?.result.created).toEqual([]);
        expect(second?.result.expiredDefaultRows).toBe(0);
        const rows =
          await tx`SELECT id, tableoid::regclass::text AS partition FROM security.security_events WHERE org_id = ${org}`;
        expect(rows.map((row) => row.id).sort()).toEqual(
          [currentId, retainedId].sort(),
        );
        expect(rows.find((row) => row.id === currentId)?.partition).toMatch(
          /^security.security_events_\d{4}_\d{2}$/,
        );
        expect(rows.find((row) => row.id === retainedId)?.partition).toBe(
          "security.security_events_default",
        );
        const protectedChildren = await tx`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
          has_table_privilege('oxagen_app', c.oid, 'SELECT') AS direct_read,
          has_table_privilege('oxagen_app', c.oid, 'INSERT') AS direct_write
        FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'security.security_events'::regclass
      `;
        expect(protectedChildren.length).toBeGreaterThanOrEqual(4);
        const unindexed = await tx`
          SELECT c.relname FROM pg_catalog.pg_class c
          WHERE (c.oid = 'security.security_events'::regclass OR c.oid IN (
            SELECT inhrelid FROM pg_catalog.pg_inherits WHERE inhparent = 'security.security_events'::regclass
          )) AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
            WHERE i.indrelid = c.oid AND a.attname = 'request_id' AND i.indisvalid
          )
        `;
        expect(unindexed).toEqual([]);

        for (const child of protectedChildren)
          expect(child).toMatchObject({
            relrowsecurity: true,
            relforcerowsecurity: true,
            direct_read: false,
            direct_write: false,
          });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
