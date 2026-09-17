// repository.github-connection.test.ts — the two guards that stand alone.
//
// `resolveWorkspaceGithubInstallation` filters on four things, and only two of
// them have a backstop: Postgres RLS (`tenant_isolation` on
// ingestion.source_connections) refuses a row from another org or workspace
// whatever the query asks for, so `org_id` and `workspace_id` are belt and
// braces. `connector_id = 'github'` and `deleted_at IS NULL` are backstopped by
// nothing at all, and nor is the `status` exclusion — drop any of them and a
// revoked (soft-deleted, or mid-delete)
// connection, or some other connector whose `deliveryConfig` happens to carry
// an `installationId`, flows straight into `getInstallationToken`. "Revoking
// the connection stops the token minting" is a security property of this one
// WHERE clause, so it is asserted against the emitted SQL rather than against a
// fake chain that discards the predicate.
//
// `installationIdOf` is the second standalone guard: its `/^\d{1,20}$/` is the
// only thing between a stored `deliveryConfig` and an arbitrary GitHub API
// path, because `getInstallationToken` interpolates the value into
// `${baseUrl}/app/installations/${installationId}/access_tokens` and validates
// nothing itself (packages/github/src/app-auth.ts) — its parameter type is
// `string | number`. So the rejections are tested directly, not transitively.
import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import {
  GITHUB_PROVIDER,
  installationIdOf,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000or01",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000ws001",
};

interface CapturedSql {
  sql: string;
  params: unknown[];
}

/**
 * A `tx` shaped exactly like the one `withTenantDb` hands the handler, which
 * rebuilds the same select against `drizzle.mock({ schema })` so the real
 * predicate can be rendered with `.toSQL()`. Nothing is executed: `where`
 * returns the rows directly, which the handler's `await` is happy with.
 */
function capturingTx(rows: readonly unknown[]) {
  const db = drizzle.mock({ schema });
  const captured: CapturedSql[] = [];
  type Chain = (fields: unknown) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        orderBy: (order: unknown) => { toSQL: () => CapturedSql };
      };
    };
  };
  // Bound: drizzle's `select` reads `this.session`, so it cannot be detached.
  const select = db.select.bind(db) as unknown as Chain;

  const tx = {
    select: (fields: unknown) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => ({
          // The resolver's ORDER BY is part of what is asserted here, so the
          // rebuilt query carries it too — a chain that swallowed it would let
          // the ordering regress without a test noticing.
          orderBy: (order: unknown) => {
            captured.push(
              select(fields)
                .from(table)
                .where(condition)
                .orderBy(order)
                .toSQL(),
            );
            return rows;
          },
        }),
      }),
    }),
  };
  return { tx, captured };
}

/** Run the resolver over `rows` and return the one query it emitted. */
async function emittedSql(rows: readonly unknown[] = []): Promise<CapturedSql> {
  const { tx, captured } = capturingTx(rows);
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  await resolveWorkspaceGithubInstallation(SCOPE);
  expect(captured).toHaveLength(1);
  return captured[0] as CapturedSql;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveWorkspaceGithubInstallation names every predicate in SQL", () => {
  it("reads ingestion.source_connections", async () => {
    const query = await emittedSql();
    expect(query.sql).toContain('"ingestion"."source_connections"');
  });

  // The RLS-backed pair. Cheap to assert, and a regression here would be a
  // cross-tenant read on any store where the policy is not in force.
  it("filters on org_id and workspace_id, and binds this scope", async () => {
    const query = await emittedSql();
    expect(query.sql).toMatch(/"org_id" = \$\d+/);
    expect(query.sql).toMatch(/"workspace_id" = \$\d+/);
    expect(query.params).toContain(SCOPE.orgId);
    expect(query.params).toContain(SCOPE.workspaceId);
  });

  // RLS does NOT back this one. Without it, any connector row carrying an
  // installationId in its deliveryConfig mints a GitHub token.
  it("filters on connector_id and binds 'github' — no other connector qualifies", async () => {
    const query = await emittedSql();
    expect(query.sql).toMatch(/"connector_id" = \$\d+/);
    expect(query.params).toContain(GITHUB_PROVIDER);
    expect(GITHUB_PROVIDER).toBe("github");
  });

  // RLS does NOT back this one either. Without it, revoking a connection stops
  // nothing: the soft-deleted row keeps minting installation tokens.
  it("excludes soft-deleted rows — revoking the connection stops the minting", async () => {
    const query = await emittedSql();
    expect(query.sql).toMatch(/"deleted_at" is null/i);
  });

  // `deleted_at IS NULL` is not enough on its own: `delete_connection` sets
  // `status = 'deleting'` and leaves `deleted_at` to the purge job that runs
  // later. A connection the person has already deleted would otherwise still
  // be reported as connected and still mint installation tokens, for however
  // long the purge takes.
  it("excludes a connection mid-delete — 'deleting' is not live", async () => {
    const query = await emittedSql();
    expect(query.sql).toMatch(/"status" not in/i);
    expect(query.params).toContain("deleting");
    expect(query.params).toContain("deleted");
  });

  // The callback that WRITES the installation
  // (`attachWorkspaceGithubInstallation`, apps/api/src/routes/v1/github-oauth.ts)
  // selects with this same predicate and `ORDER BY created_at DESC LIMIT 1`.
  // Unordered, this reader could answer an older legacy connection while the
  // writer had just attached the installation to the newest one — the three
  // repository capabilities would then act through a stale installation, with
  // nothing anywhere reporting a disagreement. The predicate was deliberately
  // made identical; the ordering has to be identical for the same reason.
  it("orders newest-first by created_at — the same row the install callback writes", async () => {
    const query = await emittedSql();
    expect(query.sql).toMatch(
      /order by "ingestion"\."source_connections"\."created_at" desc/i,
    );
  });

  it("orders by created_at and nothing else — one tie-break, not two", async () => {
    const query = await emittedSql();
    expect(query.sql.match(/order by/gi) ?? []).toHaveLength(1);
    expect(query.sql).not.toMatch(/order by[\s\S]*"updated_at"/i);
  });

  it("conjoins all five predicates — none is an alternative to another", async () => {
    const query = await emittedSql();
    // One `and` group, no `or`: a row must satisfy every predicate at once.
    expect(query.sql).not.toMatch(/\bor\b/i);
    expect(query.sql).toMatch(/\band\b.*\band\b.*\band\b.*\band\b/is);
  });

  it("binds a different scope's ids for a different scope (negative)", async () => {
    const other = {
      orgId: "0192d4a8-7c1e-7a00-8000-00000000or02",
      workspaceId: "0192d4a8-7c1e-7a00-8000-0000000ws002",
    };
    const { tx, captured } = capturingTx([]);
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    await resolveWorkspaceGithubInstallation(other);
    const query = captured[0] as CapturedSql;
    expect(query.params).toContain(other.orgId);
    expect(query.params).not.toContain(SCOPE.orgId);
    expect(query.params).not.toContain(SCOPE.workspaceId);
  });

  // `rows` arrive newest-first from the query above, so "the first that carries
  // an installation" is "the newest that carries one".
  it("answers the first row that carries an installation, and nothing about the rest", async () => {
    const { tx } = capturingTx([
      { id: "a", publicId: "con_A", status: "error", deliveryConfig: null },
      {
        id: "b",
        publicId: "con_B",
        status: "connected",
        deliveryConfig: { installationId: 777 },
      },
    ]);
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    await expect(resolveWorkspaceGithubInstallation(SCOPE)).resolves.toEqual({
      id: "b",
      publicId: "con_B",
      status: "connected",
      installationId: "777",
    });
  });

  it("answers null when no row carries an installation", async () => {
    const { tx } = capturingTx([
      {
        id: "a",
        publicId: "con_A",
        status: "pending_setup",
        deliveryConfig: {},
      },
    ]);
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    await expect(resolveWorkspaceGithubInstallation(SCOPE)).resolves.toBeNull();
  });
});

describe("installationIdOf refuses everything its regex exists to refuse", () => {
  // Each of these, accepted, would be interpolated into a GitHub API path with
  // no further validation. The first is the one that matters most: a path
  // traversal that retargets the token request at another account's resources.
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ["a path traversal", "1/../../orgs/victim"],
    ["a path segment", "555/../556"],
    ["a query string", "555?foo=bar"],
    ["a negative string", "-1"],
    ["exponent notation", "1e3"],
    ["a leading space", " 555"],
    ["a trailing space", "555 "],
    ["the empty string", ""],
    ["a 21-digit string", "1".repeat(21)],
    ["a non-numeric string", "abc"],
    ["the number zero", 0],
    ["a negative number", -1],
    ["a fractional number", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
    ["true", true],
    ["false", false],
    ["an empty object", {}],
    ["an empty array", []],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(rejected)(
    "rejects %s as an installation id",
    (_label, installationId) => {
      expect(installationIdOf({ installationId })).toBeNull();
    },
  );

  it("rejects a deliveryConfig that is not an object at all", () => {
    for (const config of [null, undefined, "555", 555, true, []])
      expect(installationIdOf(config)).toBeNull();
  });

  it("rejects a deliveryConfig with no installationId key", () => {
    expect(installationIdOf({ owner: "acme", repo: "widgets" })).toBeNull();
  });

  // The two branches agree, and this is the test that keeps them agreeing. The
  // string branch used to read `/^\d{1,20}$/`, which matches "0", while the
  // number branch has always required `raw > 0` — so the same absent
  // installation was refused as a number and accepted as a string, against a
  // doc comment promising "a plain positive integer". Harmless in isolation
  // (installation 0 does not exist, so the request 404s) but the asymmetry is
  // the kind that outlives the reason it was tolerated.
  it("refuses a zero installation id, as a string and as a number", () => {
    expect(installationIdOf({ installationId: "0" })).toBeNull();
    expect(installationIdOf({ installationId: 0 })).toBeNull();
    expect(installationIdOf({ installationId: "00" })).toBeNull();
  });

  // The guard must not be merely proven to refuse everything.
  it.each([
    ["a numeric string", "555", "555"],
    ["the number GitHub sends", 777, "777"],
    ["a 20-digit string", "1".repeat(20), "1".repeat(20)],
    ["a single digit", "7", "7"],
  ] as const)("accepts %s", (_label, installationId, expected) => {
    expect(installationIdOf({ installationId })).toBe(expected);
  });

  it("returns the stored string unchanged, never a re-serialized one", () => {
    // A 20-digit id exceeds Number.MAX_SAFE_INTEGER; round-tripping it through
    // a number would silently retarget the request.
    const id = "99999999999999999999";
    expect(installationIdOf({ installationId: id })).toBe(id);
  });
});
