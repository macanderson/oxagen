/**
 * The org-only workspace sentinel refuses rather than hides (#3132, ADR-086).
 *
 * An organisation-level surface has no workspace, so it enters the kernel with
 * `ORG_ONLY_WORKSPACE_ID` — the nil uuid — as its scope's workspace. Until this
 * change `withTenantDb` copied that value into `app.current_workspace_id` and
 * every `tenant_isolation` policy that casts the GUC NARROWED the read:
 * `workspace_nullable` answered with its `workspace_id IS NULL` rows alone,
 * `standard` and `workspace_only` answered with nothing. Postgres RLS hides
 * rather than refuses, so there was no error, no log line and nothing for a
 * `catch` to see — the caller got a short answer shaped exactly like a complete
 * one, and a signed SOC 2 export went out missing every workspace-scoped
 * security event (ADR-074's Context).
 *
 * ADR-074 tried to catch this by reading the source. Eight blind spots across
 * eight review rounds, every one of them reporting CLEAN, is the evidence that
 * a static check cannot decide it: naming a table needs module resolution and
 * dataflow, reaching a capability needs a closed set of wrapper shapes, and
 * deciding which branch runs needs path sensitivity. So the enforcement moved
 * to the one place that already knows which table is being read.
 *
 * `withTenantDb` now sets the GUC to `ORG_ONLY_WORKSPACE_GUC`, which is not a
 * uuid, and the cast raises 22P02.
 *
 * WHAT THIS SUITE IS FOR, and why it is a corpus rather than a handful of
 * cases. The claim being made is about EVERY table in `POLICY_MANIFEST`, and a
 * sample would leave the same "which ones did you look at" question the static
 * check could never answer. So the manifest itself drives the assertions: every
 * `org_only` and `org_or_global` table must still answer under an org-only
 * scope, and every `standard`, `workspace_nullable` and `workspace_only` table
 * must refuse. A table added to the manifest is covered the moment it is added,
 * and a table whose class changes moves between the two halves by itself.
 *
 * Superuser and RLS: a superuser bypasses RLS even under FORCE, so every
 * assertion runs as `oxagen_app` — the real non-superuser application role,
 * whose grants the regrant migration maintains — via `SET LOCAL ROLE`. A run as
 * the owning superuser would prove nothing about the policy.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  POLICY_MANIFEST,
  type PolicyClass,
} from "../src/tenant-policy.manifest";
import { ORG_ONLY_WORKSPACE_GUC } from "../src/tenant";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

/** The real application role. Non-superuser, no BYPASSRLS — policies apply. */
const APP_ROLE = "oxagen_app";

/** `apps/app` and `apps/api` pass this when no workspace is in scope. */
const ORG_ONLY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

const ORG = "00000000-0000-0000-0031-000000000001";
const OTHER_ORG = "00000000-0000-0000-0031-000000000002";
const WS_A = "00000000-0000-0000-0032-000000000001";
const WS_B = "00000000-0000-0000-0032-000000000002";
const PRINCIPAL = "00000000-0000-0000-0033-000000000001";
const ROLE = "00000000-0000-0000-0034-000000000001";
/**
 * A second role, used only by the org-wide INSERT below.
 * `pra_principal_role_org_null_workspace_idx` is unique on (principal, role,
 * org) for the workspace-less rows, so reusing ROLE would fail 23505 and the
 * test would pass or fail for a reason that has nothing to do with RLS.
 */
const ROLE_FOR_WRITE = "00000000-0000-0000-0034-000000000002";
/**
 * A third role, held by ONE workspace-scoped row and by no workspace-less one,
 * so the `workspace_id = NULL` update below can only be stopped by RLS.
 * Re-using ROLE would collide with `pra_sr_org` on that same partial unique
 * index and the test would pass for a reason that is not the policy — which is
 * exactly how this defect stayed invisible: the first attempt to write the
 * proof was answered 23505 by an index, not 42501 by a policy.
 */
const ROLE_FOR_MOVE = "00000000-0000-0000-0034-000000000003";

/** invalid_text_representation — the uuid cast refusing the marker. */
const INVALID_UUID = "22P02";
/** insufficient_privilege — a row a WITH CHECK refused. */
const RLS_REFUSAL = "42501";

/**
 * The classes whose USING clause never names the workspace GUC, read off
 * `predicates()` in tools/scripts/gen-rls-migration.ts:
 *
 *   org_only       org_id = ORG                        — no workspace GUC
 *   org_or_global  org_id IS NULL OR org_id = ORG      — no workspace GUC
 *
 * Everything else casts it, and therefore refuses. This constant is asserted
 * against the manifest's own `PolicyClass` union below, so a sixth class
 * cannot be added without landing in one half deliberately.
 */
const UNAFFECTED_CLASSES: ReadonlySet<PolicyClass> = new Set<PolicyClass>([
  "org_only",
  "org_or_global",
]);

const affected = POLICY_MANIFEST.filter(
  (e) => !UNAFFECTED_CLASSES.has(e.policyClass),
);
const unaffected = POLICY_MANIFEST.filter((e) =>
  UNAFFECTED_CLASSES.has(e.policyClass),
);

/**
 * Every assertion that counts rows names `role_id = ROLE`, so the one test that
 * INSERTs a row cannot shift a count another test makes. Test order is not a
 * thing to rely on, and a suite whose answer depends on it reports the wrong
 * reason when it fails.
 */

/** One transaction, as the app role, policies live, GUCs as named. */
async function inScope<T>(
  gucs: {
    org: string;
    workspace: string;
    orgWide?: "on" | "off";
    bypass?: "on" | "off";
  },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${gucs.org},                true),
        set_config('app.current_workspace_id', ${gucs.workspace},          true),
        set_config('app.org_wide',             ${gucs.orgWide ?? "off"},   true),
        set_config('app.rls_bypass',           ${gucs.bypass ?? "off"},    true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * What `withTenantDb` puts in the workspace GUC for an org-only scope. Read
 * from the seam rather than restated, so a change to the marker moves this
 * suite with it instead of leaving it asserting a value nothing sets.
 */
const orgOnly = { org: ORG, workspace: ORG_ONLY_WORKSPACE_GUC };

/** The SQLSTATE and message of a statement the database refused. */
async function refusalOf(
  p: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) throw new Error("expected the statement to be refused");
  const { code, message } = err as { code?: string; message?: string };
  return { code: String(code), message: String(message) };
}

/** Thrown to force a ROLLBACK; never escapes `inScopeRolledBack`. */
class Rollback extends Error {}

/**
 * `inScope`, but the transaction is ROLLED BACK whatever the statements did.
 *
 * The destructive cases below have to run a real DELETE/UPDATE against the real
 * policies to learn how many rows Postgres would let them destroy — a count
 * from `pg_policies` is a reading of the SQL text, not an observation of a
 * refused row, and the two have already disagreed once on this branch. Rolling
 * back is what lets the corpus above keep its rows while these tests still
 * execute the statement they are about.
 */
async function inScopeRolledBack<T>(
  gucs: {
    org: string;
    workspace: string;
    orgWide?: "on" | "off";
    bypass?: "on" | "off";
  },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let captured = false;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
      await tx`
        SELECT
          set_config('app.current_org_id',       ${gucs.org},                true),
          set_config('app.current_workspace_id', ${gucs.workspace},          true),
          set_config('app.org_wide',             ${gucs.orgWide ?? "off"},   true),
          set_config('app.rls_bypass',           ${gucs.bypass ?? "off"},    true)
      `;
      result = await fn(tx);
      captured = true;
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  if (!captured) throw new Error("the rolled-back body did not complete");
  return result as T;
}

beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG}, 'sr_org', 'Sentinel Refusal Org', 'sr-org', 'sroa',
         'free', 'active', 'business'),
        (${OTHER_ORG}, 'sr_other', 'Other Org', 'sr-other', 'srob',
         'free', 'active', 'business')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_A}, 'sr_ws_a', ${ORG}, 'WS A', 'sr-ws-a', 'srwa'),
        (${WS_B}, 'sr_ws_b', ${ORG}, 'WS B', 'sr-ws-b', 'srwb')
      ON CONFLICT (id) DO NOTHING
    `;
    // Three role assignments on one workspace_nullable table: one org-wide,
    // one in each workspace. Under the old sentinel an org-level read saw the
    // first and nothing else — the silent under-read, with the count off by
    // two. None of these columns carries an FK, so no principal or role row is
    // needed; the question is what the POLICY shows.
    await tx`
      INSERT INTO iam.principal_role_assignments
        (public_id, principal_id, role_id, org_id, workspace_id)
      VALUES
        ('pra_sr_org', ${PRINCIPAL}, ${ROLE}, ${ORG}, NULL),
        ('pra_sr_a',   ${PRINCIPAL}, ${ROLE}, ${ORG}, ${WS_A}),
        ('pra_sr_b',   ${PRINCIPAL}, ${ROLE}, ${ORG}, ${WS_B}),
        ('pra_sr_oth', ${PRINCIPAL}, ${ROLE}, ${OTHER_ORG}, NULL),
        ('pra_sr_move', ${PRINCIPAL}, ${ROLE_FOR_MOVE}, ${ORG}, ${WS_A})
      ON CONFLICT (public_id) DO NOTHING
    `;
    // One `standard` row per workspace. `standard` is the class with NO
    // workspace-less escape hatch, so it is where an org-wide DELETE would do
    // its worst: every row in the organisation names a workspace.
    await tx`
      INSERT INTO workspace.workspace_slug_history
        (public_id, org_id, workspace_id, old_slug, new_slug)
      VALUES
        ('wsh_sr_a', ${ORG}, ${WS_A}, 'sr-ws-a-old', 'sr-ws-a'),
        ('wsh_sr_b', ${ORG}, ${WS_B}, 'sr-ws-b-old', 'sr-ws-b')
      ON CONFLICT (public_id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM iam.principal_role_assignments
             WHERE org_id IN (${ORG}, ${OTHER_ORG})`;
    await tx`DELETE FROM workspace.workspaces WHERE org_id = ${ORG}`;
    await tx`DELETE FROM org.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`;
  });
  await sql.end({ timeout: 5 });
});

describe("the policy manifest and the workspace GUC", () => {
  // The split this whole suite rests on. Stated against the real union so a
  // sixth PolicyClass fails here — where someone has to read the generator and
  // decide which half it belongs in — rather than silently defaulting to one.
  it("puts every PolicyClass in exactly one half", () => {
    const seen = new Set<PolicyClass>(
      POLICY_MANIFEST.map((e) => e.policyClass),
    );
    for (const cls of seen) {
      const isUnaffected = UNAFFECTED_CLASSES.has(cls);
      const isAffected = affected.some((e) => e.policyClass === cls);
      expect(isUnaffected !== isAffected).toBe(true);
    }
    expect(affected.length + unaffected.length).toBe(POLICY_MANIFEST.length);
    expect(affected.length).toBeGreaterThan(0);
    expect(unaffected.length).toBeGreaterThan(0);
  });

  // DoD: "tenant_isolation policies verified to raise on a non-UUID GUC". The
  // refusal is not a property of one policy that happens to be written that
  // way — it is a property of every policy the generator emits, and this reads
  // the LIVE catalogue rather than the generator's source, so a policy
  // hand-written past the generator is caught too.
  it("casts the workspace GUC to uuid in every live policy that names it", async () => {
    const rows = await sql<{ table: string; qual: string }[]>`
      SELECT schemaname || '.' || tablename AS table, qual
      FROM pg_policies
      WHERE policyname = 'tenant_isolation'
        AND qual LIKE '%app.current_workspace_id%'
    `;
    expect(rows.length).toBeGreaterThan(0);
    const notCast = rows.filter(
      (r) =>
        !/NULLIF\(current_setting\('app\.current_workspace_id'::text, true\), ''::text\)\)::uuid/i.test(
          r.qual,
        ),
    );
    expect(notCast.map((r) => r.table)).toEqual([]);
  });

  // Every manifest table whose class names the GUC must actually have a live
  // policy that does. Without this, a table could pass the refusal tests below
  // by having no policy at all.
  it("gives every affected manifest table a live policy naming the GUC", async () => {
    const rows = await sql<{ table: string }[]>`
      SELECT schemaname || '.' || tablename AS table
      FROM pg_policies
      WHERE policyname = 'tenant_isolation'
        AND qual LIKE '%app.current_workspace_id%'
    `;
    const live = new Set(rows.map((r) => r.table));
    const missing = affected.map((e) => e.table).filter((t) => !live.has(t));
    expect(missing).toEqual([]);
  });
});

describe("a read under the org-only scope", () => {
  // The corpus, refusing half. Every standard / workspace_nullable /
  // workspace_only table in the manifest, not a sample.
  it.each(affected.map((e) => [e.table, e.policyClass] as const))(
    "refuses %s (%s) with 22P02 instead of answering short",
    async (table, _cls) => {
      const { code, message } = await refusalOf(
        inScope(orgOnly, (tx) => tx.unsafe(`SELECT count(*) FROM ${table}`)),
      );
      expect(code).toBe(INVALID_UUID);
      // The marker is prose so the error names its own cause with no lookup.
      expect(message).toContain(ORG_ONLY_WORKSPACE_GUC);
    },
  );

  // The corpus, answering half — the evidence that this change does not break
  // the org-level reads that were always correct. Most of the sentinel-scoped
  // code in the tree reads exactly these tables, and none of it changes.
  it.each(unaffected.map((e) => [e.table, e.policyClass] as const))(
    "still answers %s (%s)",
    async (table, _cls) => {
      const rows = await inScope(orgOnly, (tx) =>
        tx.unsafe(`SELECT count(*)::text AS n FROM ${table}`),
      );
      expect(rows).toHaveLength(1);
    },
  );

  // A table with no tenant_isolation policy is outside the refusal by
  // construction — RLS is not what isolates it. Named so the boundary is a
  // stated property rather than an absence somebody later reads as coverage.
  it("still answers a table that carries no tenant_isolation policy", async () => {
    const rows = await inScope(
      orgOnly,
      (tx) => tx`SELECT count(*)::text AS n FROM auth.users`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("what the refusal does not depend on", () => {
  // The property that closes the residual a row-time check would have. Postgres
  // folds stable functions while estimating selectivity, so the cast runs when
  // the statement is PLANNED. There is no query shape — an empty table, a
  // LIMIT that stops early, a predicate that excludes every hidden row — that
  // reaches a short answer without raising.
  it("raises while planning, so EXPLAIN raises too", async () => {
    const { code } = await refusalOf(
      inScope(
        orgOnly,
        (tx) =>
          tx`EXPLAIN (COSTS OFF) SELECT 1 FROM iam.principal_role_assignments`,
      ),
    );
    expect(code).toBe(INVALID_UUID);
  });

  it("raises for an organisation that owns no rows at all", async () => {
    const empty = "00000000-0000-0000-0031-0000000000ff";
    const { code } = await refusalOf(
      inScope(
        { org: empty, workspace: ORG_ONLY_WORKSPACE_GUC },
        (tx) => tx`SELECT count(*) FROM iam.principal_role_assignments`,
      ),
    );
    expect(code).toBe(INVALID_UUID);
  });

  it("raises under a LIMIT that would have stopped before a hidden row", async () => {
    const { code } = await refusalOf(
      inScope(
        orgOnly,
        (tx) =>
          tx`SELECT public_id FROM iam.principal_role_assignments LIMIT 1`,
      ),
    );
    expect(code).toBe(INVALID_UUID);
  });

  // app.rls_bypass='on' does NOT suppress it, for the same reason: the cast is
  // folded before the bypass disjunct is evaluated. Bypassed work must
  // therefore not carry this marker — withSystemDb sets no workspace GUC at
  // all, which is why it is unaffected, and this is the assertion that says so.
  it("is not suppressed by app.rls_bypass", async () => {
    const { code } = await refusalOf(
      inScope(
        { ...orgOnly, bypass: "on" },
        (tx) => tx`SELECT count(*) FROM iam.principal_role_assignments`,
      ),
    );
    expect(code).toBe(INVALID_UUID);
  });

  it("leaves a real workspace scope exactly as it was", async () => {
    const [row] = await inScope(
      { org: ORG, workspace: WS_A },
      (tx) =>
        tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM iam.principal_role_assignments
        WHERE org_id = ${ORG} AND role_id = ${ROLE}
      `,
    );
    // The org-wide assignment plus WS_A's. WS_B's stays hidden, which is what
    // a workspace scope is for.
    expect(row?.n).toBe("2");
  });

  // What the nil uuid used to do, kept as the witness for WHY this changed. If
  // a future edit puts a uuid back in the GUC, this is the assertion that
  // notices, because the under-read comes back with it.
  it("would have answered short under the nil uuid, which is the defect", async () => {
    const [row] = await inScope(
      { org: ORG, workspace: ORG_ONLY_WORKSPACE_ID },
      (tx) => tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM iam.principal_role_assignments
        WHERE org_id = ${ORG} AND role_id = ${ROLE}
      `,
    );
    // Three assignments exist in this org. One is visible. Nothing raised.
    expect(row?.n).toBe("1");
    expect(ORG_ONLY_WORKSPACE_GUC).not.toBe(ORG_ONLY_WORKSPACE_ID);
  });
});

describe("workspace calls cannot write shared org rows", () => {
  const workspace = { org: ORG, workspace: WS_A };

  it("reads shared rows without gaining permission to delete them", async () => {
    const result = await inScopeRolledBack(workspace, async (tx) => {
      const rows =
        await tx`SELECT public_id FROM iam.principal_role_assignments WHERE public_id = 'pra_sr_org'`;
      const deleted =
        await tx`DELETE FROM iam.principal_role_assignments WHERE public_id = 'pra_sr_org'`;
      return { visible: rows.length, deleted: deleted.count };
    });
    expect(result).toEqual({ visible: 1, deleted: 0 });
  });

  it("refuses promotion of an owned workspace row into org scope", async () => {
    const { code } = await refusalOf(
      inScopeRolledBack(
        workspace,
        (tx) => tx`
      UPDATE iam.principal_role_assignments SET workspace_id = NULL WHERE public_id = 'pra_sr_move'
    `,
      ),
    );
    expect(code).toBe(RLS_REFUSAL);
  });

  it("cannot update or claim an existing shared org row", async () => {
    const result = await inScopeRolledBack(workspace, async (tx) => {
      const unchanged =
        await tx`UPDATE iam.principal_role_assignments SET deleted_at = now() WHERE public_id = 'pra_sr_org'`;
      const claimed =
        await tx`UPDATE iam.principal_role_assignments SET workspace_id = ${WS_A}, role_id = ${ROLE_FOR_WRITE} WHERE public_id = 'pra_sr_org'`;
      return { updated: unchanged.count, claimed: claimed.count };
    });
    expect(result).toEqual({ updated: 0, claimed: 0 });
  });

  it("refuses insertion of an org-level assignment from a workspace", async () => {
    const { code } = await refusalOf(
      inScopeRolledBack(
        workspace,
        (tx) => tx`
      INSERT INTO iam.principal_role_assignments (public_id, principal_id, role_id, org_id, workspace_id)
      VALUES ('pra_sr_workspace_denied', ${PRINCIPAL}, ${ROLE_FOR_WRITE}, ${ORG}, NULL)
    `,
      ),
    );
    expect(code).toBe(RLS_REFUSAL);
  });

  it("still allows writes to the caller's own workspace", async () => {
    const count = await inScopeRolledBack(workspace, async (tx) => {
      const rows =
        await tx`UPDATE iam.principal_role_assignments SET workspace_id = ${WS_A} WHERE public_id = 'pra_sr_move'`;
      return rows.count;
    });
    expect(count).toBe(1);
  });
});

describe("withOrgDb — the organisation-wide read seam", () => {
  const orgWide = {
    org: ORG,
    // withOrgDb leaves the workspace GUC EMPTY, not at the org-only marker:
    // `nullif('', '')::uuid` is NULL and casts cleanly, where the marker would
    // raise at plan time whatever disjunct stands in front of it.
    workspace: "",
    orgWide: "on" as const,
  };

  it("answers with every workspace's rows in the organisation", async () => {
    const [row] = await inScope(
      orgWide,
      (tx) => tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM iam.principal_role_assignments
      WHERE org_id = ${ORG} AND role_id = ${ROLE}
    `,
    );
    expect(row?.n).toBe("3");
  });

  // The org fence is still the database's. This is what the seam buys over
  // `withSystemDb` + a hand-written eq(orgId): the predicate below deliberately
  // does NOT fence the org, and the other organisation's row is still invisible.
  it("keeps another organisation's rows invisible with no application fence", async () => {
    const rows = await inScope(
      orgWide,
      (tx) => tx<{ orgId: string }[]>`
      SELECT DISTINCT org_id AS "orgId" FROM iam.principal_role_assignments
    `,
    );
    expect(rows.map((r) => r.orgId)).toEqual([ORG]);
  });

  it("reads a standard table across the organisation's workspaces", async () => {
    const [row] = await inScope(
      orgWide,
      (tx) => tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM workspace.workspace_slug_history
    `,
    );
    // Two rows, one per workspace. A count is the assertion rather than a
    // non-empty result because "the seam widened the read" and "the seam
    // returned something" are different claims.
    expect(row?.n).toBe("2");
  });

  it("a workspace scope still sees only its own rows on that table", async () => {
    const [row] = await inScope(
      { org: ORG, workspace: WS_A },
      (tx) => tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM workspace.workspace_slug_history
    `,
    );
    expect(row?.n).toBe("1");
  });

  /**
   * THE WIDENING IS READ-ONLY BECAUSE OF ITS SHAPE, NOT BECAUSE CALLERS BEHAVE.
   *
   * Postgres applies a policy's USING clause to the OLD rows of an UPDATE and
   * of a DELETE, not only to a SELECT, and WITH CHECK does not run for DELETE
   * at all. So an org-wide disjunct inside the `tenant_isolation` USING —
   * which is where it lived when this branch first shipped it — did not widen
   * the read, it widened the reach of `DELETE` to every workspace in the
   * organisation, and on a `workspace_nullable` table it let an UPDATE move a
   * workspace row to `workspace_id = NULL`, where the unchanged WITH CHECK
   * then admits it. `withOrgDb` is documented as a read seam; that made it a
   * destructive one.
   *
   * The org-wide predicate now lives in its own `FOR SELECT` policy
   * (`tenant_org_wide_read`), so the destructive path cannot SEE the widened
   * row set rather than being trusted not to touch it. Permissive policies are
   * OR'd within a command and AND'd across command types, so the SELECT policy
   * widens reads while `tenant_isolation`'s FOR ALL USING — which has no
   * org-wide disjunct any more — still governs UPDATE and DELETE.
   *
   * Every case here runs the real statement and reads `count`, then rolls the
   * transaction back. A refusal and a zero-row statement are both acceptable
   * answers; what is not acceptable is a row destroyed.
   */
  describe("the widening does not reach UPDATE or DELETE", () => {
    it("deletes 0 rows of another workspace on a standard table", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          DELETE FROM workspace.workspace_slug_history WHERE org_id = ${ORG}
        `;
        return res.count;
      });
      expect(count).toBe(0);
    });

    it("deletes 0 workspace-scoped rows on a workspace_nullable table", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          DELETE FROM iam.principal_role_assignments
          WHERE public_id IN ('pra_sr_a', 'pra_sr_b')
        `;
        return res.count;
      });
      expect(count).toBe(0);
    });

    it("cannot delete the whole organisation's assignments", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          DELETE FROM iam.principal_role_assignments WHERE role_id = ${ROLE}
        `;
        return res.count;
      });
      // The org-wide row (workspace_id IS NULL) is the only one this seam may
      // reach, and it reaches it through workspace_nullable's own NULL
      // disjunct — not through the widening. `pra_sr_a` and `pra_sr_b` survive.
      expect(count).toBe(1);
    });

    it("updates 0 rows when moving another workspace's row to workspace_id NULL", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          UPDATE iam.principal_role_assignments
          SET workspace_id = NULL
          WHERE public_id = 'pra_sr_move'
        `;
        return res.count;
      });
      // WITH CHECK admits workspace_id IS NULL, so nothing downstream of the
      // old-row test would have stopped this. The old-row test is the whole
      // defence, which is why it must not carry the org-wide disjunct.
      expect(count).toBe(0);
    });

    it("updates 0 rows of another workspace on a standard table", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          UPDATE workspace.workspace_slug_history
          SET redirect_enabled = false
          WHERE org_id = ${ORG}
        `;
        return res.count;
      });
      expect(count).toBe(0);
    });

    // The write `withOrgDb` is documented to accept, held here so the fix above
    // cannot be "turn the seam off". `org.member_role.change` soft-deletes and
    // re-inserts exactly this row shape inside one withOrgDb transaction.
    it("still updates the org-wide row that names no workspace", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          UPDATE iam.principal_role_assignments
          SET deleted_at = now()
          WHERE public_id = 'pra_sr_org'
        `;
        return res.count;
      });
      expect(count).toBe(1);
    });

    // The other live writer's table. `org.org_users` is `org_only`, so it never
    // had a workspace half to widen and the narrowing cannot have touched it —
    // asserted rather than argued, because `org.member_role.change` updates it
    // inside a withOrgDb transaction and its unit suite mocks the seam away.
    // `workspace.workspaces` stands in for it here: same class, and this suite
    // already owns two rows on it.
    it("still writes an org_only table across the organisation's workspaces", async () => {
      const count = await inScopeRolledBack(orgWide, async (tx) => {
        const res = await tx`
          UPDATE workspace.workspaces SET name = 'renamed' WHERE org_id = ${ORG}
        `;
        return res.count;
      });
      expect(count).toBe(2);
    });

    // A workspace scope is untouched by any of this: `tenant_isolation` is the
    // only policy that matches, exactly as before ADR-086.
    it("leaves a workspace scope able to delete its own row", async () => {
      const count = await inScopeRolledBack(
        { org: ORG, workspace: WS_A },
        async (tx) => {
          const res = await tx`
            DELETE FROM iam.principal_role_assignments WHERE public_id = 'pra_sr_a'
          `;
          return res.count;
        },
      );
      expect(count).toBe(1);
    });

    // A catalogue reading, kept deliberately SECONDARY to the row counts above:
    // it cannot tell you a row was refused, only that the policy that refuses
    // it is shaped the way the generator emits it. It is here to catch a policy
    // hand-written past the generator with the org-wide predicate back in a
    // FOR ALL clause, which the row counts would then not be testing.
    it("never carries the org-wide predicate in a policy that governs writes", async () => {
      const rows = await sql<
        { table: string; policyname: string; cmd: string }[]
      >`
        SELECT schemaname || '.' || tablename AS table, policyname, cmd
        FROM pg_policies
        WHERE qual LIKE '%app.org_wide%' AND cmd <> 'SELECT'
      `;
      expect(rows.map((r) => `${r.table} ${r.policyname} ${r.cmd}`)).toEqual(
        [],
      );
    });

    it("gives every org-wide-read class a live FOR SELECT policy", async () => {
      const widened = POLICY_MANIFEST.filter(
        (e) =>
          e.policyClass === "standard" ||
          e.policyClass === "workspace_nullable",
      );
      expect(widened.length).toBeGreaterThan(0);
      const rows = await sql<{ table: string }[]>`
        SELECT schemaname || '.' || tablename AS table
        FROM pg_policies
        WHERE policyname = 'tenant_org_wide_read' AND cmd = 'SELECT'
          AND qual LIKE '%app.org_wide%'
      `;
      const live = new Set(rows.map((r) => r.table));
      expect(widened.map((e) => e.table).filter((t) => !live.has(t))).toEqual(
        [],
      );
    });
  });

  // Reads widen; writes are judged by the unchanged WITH CHECK. A row naming a
  // workspace cannot be landed from here, because the workspace GUC is empty
  // and app.org_wide is absent from WITH CHECK by construction.
  it("refuses a write that names a workspace", async () => {
    const { code, message } = await refusalOf(
      inScope(
        orgWide,
        (tx) => tx`
        INSERT INTO iam.principal_role_assignments
          (public_id, principal_id, role_id, org_id, workspace_id)
        VALUES ('pra_sr_denied', ${PRINCIPAL}, ${ROLE}, ${ORG}, ${WS_A})
      `,
      ),
    );
    expect(code).toBe(RLS_REFUSAL);
    expect(message).toMatch(/row-level security/i);
  });

  // The one write it does accept: a row that names no workspace on a
  // workspace_nullable table. `change_org_member_role` writes exactly this.
  it("accepts a write that names no workspace on a workspace_nullable table", async () => {
    const written = await inScope(orgWide, async (tx) => {
      await tx`
        INSERT INTO iam.principal_role_assignments
          (public_id, principal_id, role_id, org_id, workspace_id)
        VALUES ('pra_sr_orgwide', ${PRINCIPAL}, ${ROLE_FOR_WRITE}, ${ORG}, NULL)
      `;
      const [row] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM iam.principal_role_assignments
        WHERE public_id = 'pra_sr_orgwide'
      `;
      return row?.n;
    });
    expect(written).toBe("1");
  });

  // The one under-read withOrgDb can still produce, stated rather than left to
  // be discovered. A workspace_only table has no org column for the fence to
  // hold, so its policy carries no org-wide disjunct and it reads empty here.
  // That is derivable from the class, not from a list of table names — reach
  // such a table through the org-scoped parent it hangs off.
  it("reads a workspace_only table as empty, by construction", async () => {
    const workspaceOnly = POLICY_MANIFEST.filter(
      (e) => e.policyClass === "workspace_only",
    );
    expect(workspaceOnly.length).toBeGreaterThan(0);
    for (const { table } of workspaceOnly) {
      const rows = await inScope(orgWide, (tx) =>
        tx.unsafe(`SELECT count(*)::text AS n FROM ${table}`),
      );
      expect(rows[0]).toEqual({ n: "0" });
    }
  });

  // app.org_wide is opt-in and fails closed. A transaction that never sets it
  // behaves exactly as before, which is what keeps every withTenantDb read in
  // the tree unchanged.
  it("does nothing when app.org_wide is absent", async () => {
    const [row] = (await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
      await tx`
        SELECT
          set_config('app.current_org_id',       ${ORG}, true),
          set_config('app.current_workspace_id', ${WS_A}, true),
          set_config('app.rls_bypass',           'off',  true)
      `;
      return tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM iam.principal_role_assignments
        WHERE org_id = ${ORG} AND role_id = ${ROLE}
      `;
    })) as unknown as { n: string }[];
    expect(row?.n).toBe("2");
  });
});
