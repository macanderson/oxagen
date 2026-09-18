/**
 * `20260918200000_repository_binding_heads_exclusive_across_roles.sql` — the
 * reconciliation that runs before the trigger is installed.
 *
 * The trigger forbids a linked head for a repository that is main in another
 * workspace, but it only inspects rows being written. 20260918040000 demoted
 * every later main claim to 'linked', so an upgraded database can already
 * hold exactly that pair, and a forward-only guard would leave it standing.
 * The migration deletes those linked heads (the `unlink_repository` move:
 * the head goes, the binding versions stay) before the trigger exists.
 *
 * The block is read out of the migration file rather than restated here: a
 * copy would keep passing after the migration changed. The forbidden state
 * is seeded with the trigger disabled inside the same transaction, because
 * that is the only way to reach it now, and the trigger is back before the
 * transaction commits.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database exec vitest run --config vitest.integration.config.ts integration/repository-heads-reconcile.test.ts
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const MIGRATION = new URL(
  "../atlas/migrations/20260918200000_repository_binding_heads_exclusive_across_roles.sql",
  import.meta.url,
);

const ORG = "00000000-0000-0000-0021-000000000001";
const WS_A = "00000000-0000-0000-0022-000000000001";
const WS_B = "00000000-0000-0000-0022-000000000002";
const WS_C = "00000000-0000-0000-0022-000000000003";
const CONN_A = "00000000-0000-0000-0023-000000000001";
const CONN_B = "00000000-0000-0000-0023-000000000002";
const CONN_C = "00000000-0000-0000-0023-000000000003";
const BINDING_A = "00000000-0000-0000-0024-000000000001";
const BINDING_B = "00000000-0000-0000-0024-000000000002";
const BINDING_B_OWN = "00000000-0000-0000-0024-000000000003";
const BINDING_C = "00000000-0000-0000-0024-000000000004";

/** The repository main in A and, after the demotion, linked in B. */
const CLAIMED = "9001";
/** B's own main repository, untouched by the repair. */
const B_OWN = "9002";
/** Main nowhere: linked in B and C, the many-to-many case the rule allows. */
const SHARED = "9003";

/**
 * The `DO $$ ... $$;` block that deletes linked heads whose repository is
 * main elsewhere, lifted verbatim. Split on the block terminator: the file
 * holds three DO/function bodies and a non-greedy regex would span them.
 */
function reconcileBlock(): string {
  const source = readFileSync(MIGRATION, "utf8");
  const chunk = source
    .split("$$;")
    .map((part) => `${part}$$;`)
    .find((part) =>
      part.includes('DELETE FROM "ingestion"."repository_binding_heads"'),
    );
  if (!chunk) {
    throw new Error(
      "20260918200000 no longer deletes linked heads whose repository is main elsewhere",
    );
  }
  const start = chunk.indexOf("DO $$");
  if (start < 0) {
    throw new Error("the linked-head reconciliation is no longer a DO block");
  }
  return chunk.slice(start);
}

interface HeadRow {
  workspace_id: string;
  provider_repository_id: string;
  role: string;
}

async function heads(): Promise<HeadRow[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    return tx<HeadRow[]>`
      SELECT workspace_id, provider_repository_id, role
        FROM ingestion.repository_binding_heads
       WHERE org_id = ${ORG}
       ORDER BY workspace_id, provider_repository_id
    `;
  });
}

async function bindingCount(): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    const rows = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n
        FROM ingestion.repository_bindings
       WHERE org_id = ${ORG}
    `;
    return Number(rows[0]?.n ?? 0);
  });
}

async function removeFixture(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM ingestion.repository_binding_heads WHERE org_id = ${ORG}`;
    await tx`DELETE FROM ingestion.repository_bindings WHERE org_id = ${ORG}`;
    await tx`DELETE FROM ingestion.source_connections WHERE org_id = ${ORG}`;
    await tx`DELETE FROM workspace.workspaces WHERE org_id = ${ORG}`;
    await tx`DELETE FROM org.organizations WHERE id = ${ORG}`;
  });
}

beforeAll(async () => {
  await removeFixture();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG}, 'rhr_org', 'RHR Org', 'rhr-org', 'rhr', 'free', 'active', 'business')
    `;
    await tx`
      INSERT INTO workspace.workspaces
        (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_A}, 'rhr_ws_a', ${ORG}, 'RHR A', 'rhr-a', 'rhra'),
        (${WS_B}, 'rhr_ws_b', ${ORG}, 'RHR B', 'rhr-b', 'rhrb'),
        (${WS_C}, 'rhr_ws_c', ${ORG}, 'RHR C', 'rhr-c', 'rhrc')
    `;
    await tx`
      INSERT INTO ingestion.source_connections
        (id, public_id, org_id, workspace_id, connector_id, display_name, auth_scheme, delivery_method, status)
      VALUES
        (${CONN_A}, 'rhr_conn_a', ${ORG}, ${WS_A}, 'github', 'A', 'oauth2', 'webhook', 'connected'),
        (${CONN_B}, 'rhr_conn_b', ${ORG}, ${WS_B}, 'github', 'B', 'oauth2', 'webhook', 'connected'),
        (${CONN_C}, 'rhr_conn_c', ${ORG}, ${WS_C}, 'github', 'C', 'oauth2', 'webhook', 'connected')
    `;
    // One version-1 binding behind every head. The repair must leave all of
    // them: a version is evidence for the runs that cited it.
    await tx`
      INSERT INTO ingestion.repository_bindings
        (id, public_id, org_id, workspace_id, connection_id, provider, provider_repository_id,
         provider_owner, provider_name, provider_full_name, configured_default_ref, observed_at, version)
      VALUES
        (${BINDING_A}, 'rpb_rhr_a', ${ORG}, ${WS_A}, ${CONN_A}, 'github', ${CLAIMED}, 'acme', 'claimed', 'acme/claimed', 'main', now(), 1),
        (${BINDING_B}, 'rpb_rhr_b', ${ORG}, ${WS_B}, ${CONN_B}, 'github', ${CLAIMED}, 'acme', 'claimed', 'acme/claimed', 'main', now(), 1),
        (${BINDING_B_OWN}, 'rpb_rhr_b_own', ${ORG}, ${WS_B}, ${CONN_B}, 'github', ${B_OWN}, 'acme', 'own', 'acme/own', 'main', now(), 1),
        (${BINDING_C}, 'rpb_rhr_c', ${ORG}, ${WS_C}, ${CONN_C}, 'github', ${SHARED}, 'acme', 'shared', 'acme/shared', 'main', now(), 1)
    `;
    // The state 20260918040000 leaves behind cannot be written past the
    // trigger, which is the point. Disabled for the seed only; DDL is
    // transactional, so the trigger is back before this commits and stays
    // off for nobody if the seed fails.
    await tx`ALTER TABLE ingestion.repository_binding_heads DISABLE TRIGGER repository_binding_heads_exclusive_main`;
    await tx`
      INSERT INTO ingestion.repository_binding_heads
        (org_id, workspace_id, connection_id, provider, provider_repository_id, current_binding_id, role)
      VALUES
        (${ORG}, ${WS_A}, ${CONN_A}, 'github', ${CLAIMED}, ${BINDING_A}, 'main'),
        (${ORG}, ${WS_B}, ${CONN_B}, 'github', ${CLAIMED}, ${BINDING_B}, 'linked'),
        (${ORG}, ${WS_B}, ${CONN_B}, 'github', ${B_OWN}, ${BINDING_B_OWN}, 'main'),
        (${ORG}, ${WS_B}, ${CONN_B}, 'github', ${SHARED}, ${BINDING_C}, 'linked'),
        (${ORG}, ${WS_C}, ${CONN_C}, 'github', ${SHARED}, ${BINDING_C}, 'linked')
    `;
    await tx`ALTER TABLE ingestion.repository_binding_heads ENABLE TRIGGER repository_binding_heads_exclusive_main`;
  });
});

afterAll(async () => {
  await removeFixture();
  await sql.end({ timeout: 5 });
});

describe("20260918200000: linked heads whose repository is main elsewhere are removed before the trigger", () => {
  it("seeds the pair the demotion leaves: main in A, linked in B", async () => {
    expect(await heads()).toEqual([
      { workspace_id: WS_A, provider_repository_id: CLAIMED, role: "main" },
      { workspace_id: WS_B, provider_repository_id: CLAIMED, role: "linked" },
      { workspace_id: WS_B, provider_repository_id: B_OWN, role: "main" },
      { workspace_id: WS_B, provider_repository_id: SHARED, role: "linked" },
      { workspace_id: WS_C, provider_repository_id: SHARED, role: "linked" },
    ]);
    expect(await bindingCount()).toBe(4);
  });

  it("deletes only B's linked head on A's main repository; the main head, B's own main, the shared links and every binding version stay", async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await tx.unsafe(reconcileBlock());
    });

    expect(await heads()).toEqual([
      { workspace_id: WS_A, provider_repository_id: CLAIMED, role: "main" },
      { workspace_id: WS_B, provider_repository_id: B_OWN, role: "main" },
      { workspace_id: WS_B, provider_repository_id: SHARED, role: "linked" },
      { workspace_id: WS_C, provider_repository_id: SHARED, role: "linked" },
    ]);
    expect(await bindingCount()).toBe(4);
  });

  it("is idempotent: a second run on a reconciled table changes nothing", async () => {
    const before = await heads();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await tx.unsafe(reconcileBlock());
    });
    expect(await heads()).toEqual(before);
  });

  it("the trigger then refuses the pair the repair removed, so it cannot come back", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
        await tx`
          INSERT INTO ingestion.repository_binding_heads
            (org_id, workspace_id, connection_id, provider, provider_repository_id, current_binding_id, role)
          VALUES
            (${ORG}, ${WS_B}, ${CONN_B}, 'github', ${CLAIMED}, ${BINDING_B}, 'linked')
        `;
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "repository_binding_heads_linked_is_main_elsewhere",
    });
  });
});
