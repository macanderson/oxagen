/**
 * `20260927185600_repository_binding_heads_main_to_steering.sql`, applied to
 * the state it was written for.
 *
 * CI migrates this database before the suite runs, so the table already
 * carries the migration. Each test puts the pre-migration schema back inside
 * one transaction, seeds heads the old schema allowed, applies the migration
 * file as written, and rolls everything back. The pre-migration schema comes
 * from 20260926120000's own file, plus the two things 20260927185600 changed
 * that the earlier file does not restore: the per-workspace steering index and
 * the `main` default. The migration is read from its file rather than restated
 * here, so a change to it is a change to what these tests apply.
 *
 * The seed is written with the trigger on. Every row is one the old guard
 * accepts, so the fixture is a state production could hold. The one test that
 * needs a state the guard refuses turns the trigger off for its seed and on
 * again before the apply.
 *
 * 20261003170000 dropped that trigger and its function (ADR-293), so the CI
 * database holds neither. The earlier file recreates the function, and the
 * fixture recreates the trigger from 20260918200000's own statement, so the
 * tests below still apply 20260927185600 to the schema it was written for.
 * The last describe applies 20261003170000 on top and checks the rules that
 * hold now: any workspace may link any repository, and a repository still
 * steers one workspace.
 *
 * This file replaces repository-heads-reconcile.test.ts. That witness seeded
 * role `main` rows in a committed transaction, and the role check now refuses
 * them.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database exec vitest run --config vitest.integration.config.ts integration/repository-heads-main-to-steering.test.ts
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

// The migration raises a NOTICE per moved head. The assertions read the rows,
// so the notices only add noise to the CI log.
const sql = postgres(process.env["DATABASE_URL"]!, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});
afterAll(() => sql.end({ timeout: 5 }));

type Tx = postgres.TransactionSql;

function migrationFile(name: string): string {
  return readFileSync(
    new URL(`../atlas/migrations/${name}`, import.meta.url),
    "utf8",
  );
}

const MIGRATION = migrationFile(
  "20260927185600_repository_binding_heads_main_to_steering.sql",
);
const PREVIOUS = migrationFile(
  "20260926120000_repository_binding_heads_steering_role.sql",
);
const UNRESTRICTED = migrationFile(
  "20261003170000_repository_binding_heads_links_unrestricted.sql",
);

/**
 * The statements in 20260918200000 that create the trigger, from its file.
 * The rest of that file deletes rows across the whole table, so only this
 * tail is applied.
 */
function triggerStatements(): string {
  const file = migrationFile(
    "20260918200000_repository_binding_heads_exclusive_across_roles.sql",
  );
  const start = file.indexOf(
    'DROP TRIGGER IF EXISTS "repository_binding_heads_exclusive_main"',
  );
  if (start < 0) {
    throw new Error("20260918200000 no longer creates the exclusive-main trigger");
  }
  const tail = file.slice(start);
  if (!tail.includes('CREATE TRIGGER "repository_binding_heads_exclusive_main"')) {
    throw new Error("the trigger statement in 20260918200000 moved");
  }
  return tail;
}

/**
 * The migration's `DO $$ ... $$;` block that moves the heads. The file holds a
 * DO block and a function body, so split on the block terminator rather than
 * match with a regex that could span both.
 */
function moveBlock(): string {
  const chunk = MIGRATION.split("$$;")
    .map((part) => `${part}$$;`)
    .find((part) => part.includes('UPDATE "ingestion"."repository_binding_heads"'));
  if (!chunk) {
    throw new Error("20260927185600 no longer updates repository_binding_heads");
  }
  const start = chunk.indexOf("DO $$");
  if (start < 0) {
    throw new Error("the head move in 20260927185600 is no longer a DO block");
  }
  return chunk.slice(start);
}

const ORG = "00000000-0000-0000-0041-000000000001";

/** One main head and one linked head. */
const WS_MAIN = "00000000-0000-0000-0042-000000000001";
/** An older main head and a newer steering head. */
const WS_BOTH = "00000000-0000-0000-0042-000000000002";
/** Three main heads, two of them created at the same instant. */
const WS_TWO = "00000000-0000-0000-0042-000000000003";
/** Linked heads only. */
const WS_LINKED = "00000000-0000-0000-0042-000000000004";
/** No heads. The refusal tests write into it. */
const WS_NEW = "00000000-0000-0000-0042-000000000005";

const WORKSPACES = [WS_MAIN, WS_BOTH, WS_TWO, WS_LINKED, WS_NEW] as const;

/** Each workspace's own connection. Connections are per workspace. */
const CONNECTIONS = new Map<string, string>(
  WORKSPACES.map((ws, i) => [
    ws,
    `00000000-0000-0000-0043-${String(i + 1).padStart(12, "0")}`,
  ]),
);

function connectionOf(workspaceId: string): string {
  const connection = CONNECTIONS.get(workspaceId);
  if (!connection) throw new Error(`no connection for workspace ${workspaceId}`);
  return connection;
}

/** WS_MAIN's main repository. */
const R_A = "9101";
/** Linked in WS_MAIN and in WS_LINKED. */
const R_SHARED = "9102";
/** WS_BOTH's older main repository. */
const R_B_MAIN = "9103";
/** WS_BOTH's newer steering repository. */
const R_B_STEER = "9104";
/** WS_TWO's newest main repository. */
const R_C_NEW = "9105";
/** WS_TWO's two oldest main repositories, created at the same instant. */
const R_C_TIE_LOW = "9106";
const R_C_TIE_HIGH = "9107";
/** Linked in WS_LINKED alone. */
const R_D_ONLY = "9108";
/** In no workspace until a test writes it. */
const R_FRESH = "9109";

interface Seed {
  id: string;
  workspaceId: string;
  repo: string;
  role: "main" | "linked" | "steering";
  createdAt: string;
}

const T0 = "2026-09-01T00:00:00Z";
const T1 = "2026-09-02T00:00:00Z";
const T2 = "2026-09-03T00:00:00Z";

/**
 * Every head the fixture seeds. Head ids are fixed so the tie in WS_TWO has a
 * known winner: the lower id.
 */
const SEEDS: readonly Seed[] = [
  { id: "00000000-0000-0000-0045-000000000001", workspaceId: WS_MAIN, repo: R_A, role: "main", createdAt: T0 },
  { id: "00000000-0000-0000-0045-000000000002", workspaceId: WS_MAIN, repo: R_SHARED, role: "linked", createdAt: T1 },
  { id: "00000000-0000-0000-0045-000000000003", workspaceId: WS_BOTH, repo: R_B_MAIN, role: "main", createdAt: T0 },
  { id: "00000000-0000-0000-0045-000000000004", workspaceId: WS_BOTH, repo: R_B_STEER, role: "steering", createdAt: T2 },
  { id: "00000000-0000-0000-0045-000000000005", workspaceId: WS_TWO, repo: R_C_NEW, role: "main", createdAt: T1 },
  { id: "00000000-0000-0000-0045-000000000006", workspaceId: WS_TWO, repo: R_C_TIE_LOW, role: "main", createdAt: T0 },
  { id: "00000000-0000-0000-0045-000000000007", workspaceId: WS_TWO, repo: R_C_TIE_HIGH, role: "main", createdAt: T0 },
  { id: "00000000-0000-0000-0045-000000000008", workspaceId: WS_LINKED, repo: R_SHARED, role: "linked", createdAt: T0 },
  { id: "00000000-0000-0000-0045-000000000009", workspaceId: WS_LINKED, repo: R_D_ONLY, role: "linked", createdAt: T1 },
];

function bindingOf(seedIndex: number): string {
  return `00000000-0000-0000-0044-${String(seedIndex + 1).padStart(12, "0")}`;
}

/** A binding for heads the tests write after the move. */
const SPARE_BINDING = "00000000-0000-0000-0044-000000000099";

interface HeadRow {
  workspace_id: string;
  provider_repository_id: string;
  role: string;
}

async function orgHeads(tx: Tx): Promise<HeadRow[]> {
  return tx<HeadRow[]>`
    SELECT workspace_id, provider_repository_id, role
      FROM ingestion.repository_binding_heads
     WHERE org_id = ${ORG}
     ORDER BY workspace_id, provider_repository_id
  `;
}

async function headCount(tx: Tx): Promise<number> {
  const [row] = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM ingestion.repository_binding_heads
     WHERE org_id = ${ORG}
  `;
  return Number(row?.n ?? 0);
}

async function bindingCount(tx: Tx): Promise<number> {
  const [row] = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n
      FROM ingestion.repository_bindings
     WHERE org_id = ${ORG}
  `;
  return Number(row?.n ?? 0);
}

/**
 * Puts the table back in the state 20260927185600 was written against. The
 * earlier file recreates the trigger's function, and the trigger itself comes
 * from 20260918200000, because 20261003170000 dropped both.
 */
async function restorePreviousSchema(tx: Tx): Promise<void> {
  await tx`DROP INDEX IF EXISTS ingestion.repository_binding_heads_workspace_steering_uq`;
  await tx.unsafe(PREVIOUS);
  await tx.unsafe(triggerStatements());
  await tx`ALTER TABLE ingestion.repository_binding_heads ALTER COLUMN role SET DEFAULT 'main'`;
}

async function seedTenant(tx: Tx): Promise<void> {
  await tx`
    INSERT INTO org.organizations
      (id, public_id, name, slug, namespace, plan_type, status, type)
    VALUES
      (${ORG}, 'rms_org', 'RMS Org', 'rms-org', 'rms', 'free', 'active', 'business')
  `;
  for (const [i, ws] of WORKSPACES.entries()) {
    await tx`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES (${ws}, ${`rms_ws_${i}`}, ${ORG}, ${`RMS ${i}`}, ${`rms-${i}`}, ${`rms${i}`})
    `;
    await tx`
      INSERT INTO ingestion.source_connections
        (id, public_id, org_id, workspace_id, connector_id, display_name, auth_scheme, delivery_method, status)
      VALUES
        (${connectionOf(ws)}, ${`rms_conn_${i}`}, ${ORG}, ${ws}, 'github', ${`RMS ${i}`}, 'oauth2', 'webhook', 'connected')
    `;
  }
  // One version-1 binding behind every head. The move rewrites heads only.
  for (const [i, seed] of SEEDS.entries()) {
    await tx`
      INSERT INTO ingestion.repository_bindings
        (id, public_id, org_id, workspace_id, connection_id, provider, provider_repository_id,
         provider_owner, provider_name, provider_full_name, configured_default_ref, observed_at, version)
      VALUES
        (${bindingOf(i)}, ${`rpb_rms_${i}`}, ${ORG}, ${seed.workspaceId}, ${connectionOf(seed.workspaceId)},
         'github', ${seed.repo}, 'acme', ${`repo-${seed.repo}`}, ${`acme/repo-${seed.repo}`}, 'main', now(), 1)
    `;
  }
  await tx`
    INSERT INTO ingestion.repository_bindings
      (id, public_id, org_id, workspace_id, connection_id, provider, provider_repository_id,
       provider_owner, provider_name, provider_full_name, configured_default_ref, observed_at, version)
    VALUES
      (${SPARE_BINDING}, 'rpb_rms_spare', ${ORG}, ${WS_NEW}, ${connectionOf(WS_NEW)},
       'github', ${R_FRESH}, 'acme', 'fresh', 'acme/fresh', 'main', now(), 1)
  `;
}

async function seedHeads(tx: Tx, seeds: readonly Seed[]): Promise<void> {
  for (const seed of seeds) {
    const i = SEEDS.indexOf(seed);
    await tx`
      INSERT INTO ingestion.repository_binding_heads
        (id, org_id, workspace_id, connection_id, provider, provider_repository_id,
         current_binding_id, role, created_at, updated_at)
      VALUES
        (${seed.id}, ${ORG}, ${seed.workspaceId}, ${connectionOf(seed.workspaceId)}, 'github',
         ${seed.repo}, ${i >= 0 ? bindingOf(i) : SPARE_BINDING}, ${seed.role}, ${seed.createdAt}, ${seed.createdAt})
    `;
  }
}

/** Writes one head after the move. */
async function writeHead(
  tx: Tx,
  workspaceId: string,
  repo: string,
  role: string | null,
): Promise<void> {
  if (role === null) {
    await tx`
      INSERT INTO ingestion.repository_binding_heads
        (org_id, workspace_id, connection_id, provider, provider_repository_id, current_binding_id)
      VALUES
        (${ORG}, ${workspaceId}, ${connectionOf(workspaceId)}, 'github', ${repo}, ${SPARE_BINDING})
    `;
    return;
  }
  await tx`
    INSERT INTO ingestion.repository_binding_heads
      (org_id, workspace_id, connection_id, provider, provider_repository_id, current_binding_id, role)
    VALUES
      (${ORG}, ${workspaceId}, ${connectionOf(workspaceId)}, 'github', ${repo}, ${SPARE_BINDING}, ${role})
  `;
}

/**
 * Runs `body` against the migrated fixture inside one transaction, then rolls
 * the transaction back. The schema changes roll back with it, so the table
 * ends each test exactly as CI migrated it.
 */
async function withMigratedFixture(
  body: (tx: Tx) => Promise<void>,
  seeds: readonly Seed[] = SEEDS,
): Promise<void> {
  const rollback = new Error("roll back the main-to-steering fixture");
  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await restorePreviousSchema(tx);
      await seedTenant(tx);
      await seedHeads(tx, seeds);
      await tx.unsafe(MIGRATION);
      await body(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

/**
 * The migrated fixture with 20261003170000 applied on top: the schema CI
 * migrates to today. Rolled back like the fixture above.
 */
async function withCurrentFixture(
  body: (tx: Tx) => Promise<void>,
): Promise<void> {
  await withMigratedFixture(async (tx) => {
    await tx.unsafe(UNRESTRICTED);
    await body(tx);
  });
}

/** The heads one repository has, by workspace, in the order orgHeads reads them. */
async function headsOfRepo(tx: Tx, repo: string): Promise<[string, string][]> {
  return (await orgHeads(tx))
    .filter((h) => h.provider_repository_id === repo)
    .map((h) => [h.workspace_id, h.role]);
}

/** Expects `write` to fail with `code` on `constraint`, in a savepoint. */
async function expectRefusal(
  tx: Tx,
  write: (sp: Tx) => Promise<void>,
  code: string,
  constraint: string,
): Promise<void> {
  await expect(tx.savepoint((sp) => write(sp))).rejects.toMatchObject({
    code,
    constraint_name: constraint,
  });
}

describe("20260927185600: every main head becomes steering or linked", () => {
  it("keeps one steering head per workspace and demotes every other main head to linked", async () => {
    await withMigratedFixture(async (tx) => {
      // In the order orgHeads reads them: by workspace, then repository.
      expect(await orgHeads(tx)).toEqual([
        // A lone main head becomes the steering head.
        { workspace_id: WS_MAIN, provider_repository_id: R_A, role: "steering" },
        { workspace_id: WS_MAIN, provider_repository_id: R_SHARED, role: "linked" },
        // A steering head outranks an older main head.
        { workspace_id: WS_BOTH, provider_repository_id: R_B_MAIN, role: "linked" },
        { workspace_id: WS_BOTH, provider_repository_id: R_B_STEER, role: "steering" },
        // The oldest main head wins, and the lower id breaks a tie.
        { workspace_id: WS_TWO, provider_repository_id: R_C_NEW, role: "linked" },
        { workspace_id: WS_TWO, provider_repository_id: R_C_TIE_LOW, role: "steering" },
        { workspace_id: WS_TWO, provider_repository_id: R_C_TIE_HIGH, role: "linked" },
        // Linked heads stay linked, including one repository linked in two
        // workspaces.
        { workspace_id: WS_LINKED, provider_repository_id: R_SHARED, role: "linked" },
        { workspace_id: WS_LINKED, provider_repository_id: R_D_ONLY, role: "linked" },
      ]);
    });
  });

  it("deletes no head and drops no binding version", async () => {
    await withMigratedFixture(async (tx) => {
      expect(await headCount(tx)).toBe(SEEDS.length);
      expect(await bindingCount(tx)).toBe(SEEDS.length + 1);
    });
  });

  it("moves nothing when the block runs a second time", async () => {
    await withMigratedFixture(async (tx) => {
      const before = await orgHeads(tx);
      await tx.unsafe(moveBlock());
      expect(await orgHeads(tx)).toEqual(before);
    });
  });

  it("leaves the role column with no default", async () => {
    await withMigratedFixture(async (tx) => {
      const [column] = await tx<{ column_default: string | null }[]>`
        SELECT column_default
          FROM information_schema.columns
         WHERE table_schema = 'ingestion'
           AND table_name = 'repository_binding_heads'
           AND column_name = 'role'
      `;
      expect(column?.column_default).toBeNull();
      // A not-null violation names the column, not a constraint.
      await expect(
        tx.savepoint((sp) => writeHead(sp, WS_NEW, R_FRESH, null)),
      ).rejects.toMatchObject({ code: "23502", column_name: "role" });
    });
  });

  it("refuses the role main", async () => {
    await withMigratedFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_NEW, R_FRESH, "main"),
        "23514",
        "repository_binding_heads_role_check",
      );
    });
  });

  it("refuses a second steering head in one workspace", async () => {
    await withMigratedFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_MAIN, R_FRESH, "steering"),
        "23505",
        "repository_binding_heads_workspace_steering_uq",
      );
    });
  });

  it("refuses a steering repository as another workspace's steering head", async () => {
    await withMigratedFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_NEW, R_A, "steering"),
        "23505",
        "repository_binding_heads_main_repository_uq",
      );
    });
  });

  // The next two refusals belong to the trigger as 20260927185600 left it.
  // 20261003170000 lifts both, and the last describe in this file checks that.
  it("refuses to link a steering repository into another workspace", async () => {
    await withMigratedFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_NEW, R_A, "linked"),
        "23505",
        "repository_binding_heads_linked_is_main_elsewhere",
      );
    });
  });

  it("refuses a linked repository as another workspace's steering head", async () => {
    await withMigratedFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_NEW, R_SHARED, "steering"),
        "23505",
        "repository_binding_heads_main_is_linked_elsewhere",
      );
    });
  });

  it("links one repository into a third workspace", async () => {
    await withMigratedFixture(async (tx) => {
      await writeHead(tx, WS_NEW, R_SHARED, "linked");
      const shared = (await orgHeads(tx)).filter(
        (h) => h.provider_repository_id === R_SHARED,
      );
      expect(shared.map((h) => [h.workspace_id, h.role])).toEqual([
        [WS_MAIN, "linked"],
        [WS_LINKED, "linked"],
        [WS_NEW, "linked"],
      ]);
    });
  });
});

describe("20260927185600 on a state the old guard refuses", () => {
  it("stops the apply when a main repository is also linked in another workspace", async () => {
    // 20260918200000 removed these pairs and its trigger refuses new ones, so
    // production cannot hold one. If one exists, the apply stops on the guard
    // rather than writing a steering head the guard forbids.
    const main = SEEDS[0]!;
    const rollback = new Error("roll back the refused-state fixture");
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
        await restorePreviousSchema(tx);
        await seedTenant(tx);
        await seedHeads(tx, [main]);
        await tx`ALTER TABLE ingestion.repository_binding_heads DISABLE TRIGGER repository_binding_heads_exclusive_main`;
        await writeHead(tx, WS_NEW, main.repo, "linked");
        await tx`ALTER TABLE ingestion.repository_binding_heads ENABLE TRIGGER repository_binding_heads_exclusive_main`;
        await expectRefusal(
          tx,
          async (sp) => {
            await sp.unsafe(MIGRATION);
          },
          "23505",
          "repository_binding_heads_main_is_linked_elsewhere",
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

describe("20261003170000: any workspace may link any repository", () => {
  it("drops the trigger and its function", async () => {
    await withCurrentFixture(async (tx) => {
      const triggers = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM pg_trigger
         WHERE tgname = 'repository_binding_heads_exclusive_main'
      `;
      expect(triggers[0]?.n).toBe("0");
      const functions = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'ingestion'
           AND p.proname = 'repository_binding_heads_guard_exclusive_main'
      `;
      expect(functions[0]?.n).toBe("0");
    });
  });

  it("links a repository another workspace steers by", async () => {
    await withCurrentFixture(async (tx) => {
      await writeHead(tx, WS_NEW, R_A, "linked");
      expect(await headsOfRepo(tx, R_A)).toEqual([
        [WS_MAIN, "steering"],
        [WS_NEW, "linked"],
      ]);
    });
  });

  it("takes a repository other workspaces link as a steering repository", async () => {
    await withCurrentFixture(async (tx) => {
      await writeHead(tx, WS_NEW, R_SHARED, "steering");
      expect(await headsOfRepo(tx, R_SHARED)).toEqual([
        [WS_MAIN, "linked"],
        [WS_LINKED, "linked"],
        [WS_NEW, "steering"],
      ]);
    });
  });

  it("promotes a linked head to steering while another workspace links the repository", async () => {
    await withCurrentFixture(async (tx) => {
      // WS_LINKED has no steering head, and WS_MAIN links R_SHARED too.
      await tx`
        UPDATE ingestion.repository_binding_heads
           SET role = 'steering'
         WHERE org_id = ${ORG}
           AND workspace_id = ${WS_LINKED}
           AND provider_repository_id = ${R_SHARED}
      `;
      expect(await headsOfRepo(tx, R_SHARED)).toEqual([
        [WS_MAIN, "linked"],
        [WS_LINKED, "steering"],
      ]);
    });
  });

  it("still refuses a second workspace steered by one repository (negative)", async () => {
    await withCurrentFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_NEW, R_A, "steering"),
        "23505",
        "repository_binding_heads_main_repository_uq",
      );
      expect(await headsOfRepo(tx, R_A)).toEqual([[WS_MAIN, "steering"]]);
    });
  });

  it("still refuses a second steering repository in one workspace (negative)", async () => {
    await withCurrentFixture(async (tx) => {
      await expectRefusal(
        tx,
        (sp) => writeHead(sp, WS_MAIN, R_FRESH, "steering"),
        "23505",
        "repository_binding_heads_workspace_steering_uq",
      );
    });
  });
});
