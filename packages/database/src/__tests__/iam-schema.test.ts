/**
 * IAM schema smoke tests for @oxagen/database (OXA-1389, Phase 2).
 *
 * Tests operate entirely on Drizzle table definitions via `getTableConfig` —
 * no live DB, no network, no random/wall-clock values.
 *
 * Assertions:
 *  1. All 7 IAM tables are importable from schema/index.
 *  2. principals and iam_sessions carry no updated_at column (append-leaning
 *     for sessions; principals has it via auditMixin — but sessions MUST NOT).
 *  3. sessions table has no updated_at column.
 *  4. principals.kind CHECK constraint exists and covers all 3 values.
 *  5. grants.effect CHECK constraint exists and covers all 3 effect values.
 *  6. role_grants table has an org_id column.
 *  7. grants has a composite index whose columns include principal_id and scope_id.
 *  8. access_requests.status CHECK constraint exists and covers all 4 values.
 *  9. roles.scope_kind CHECK exists and includes both 'org' and 'workspace'.
 * 10. iam_sessions table has a principal_id column.
 *
 * Uses the same queryChunks inspection technique as schema-append-only.test.ts.
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  principals,
  roles,
  roleGrants,
  grants,
  policies,
  accessRequests,
  iamSessions,
} from "../schema/index.js";

// ---------------------------------------------------------------------------
// Internal types for Drizzle query chunk inspection (mirrors schema-append-only.test.ts)
// ---------------------------------------------------------------------------

interface SqlLiteralChunk {
  value: string[];
}

interface ColumnRefChunk {
  name: string;
}

type QueryChunk = SqlLiteralChunk | ColumnRefChunk | unknown;

interface DrizzleCheck {
  name: string;
  value: {
    queryChunks?: QueryChunk[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenCheckSql(check: DrizzleCheck): string {
  const chunks = check.value.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk === null || typeof chunk !== "object") return "";
      const c = chunk as Record<string, unknown>;
      if (typeof c["name"] === "string") return c["name"];
      if (Array.isArray(c["value"])) {
        return (c["value"] as unknown[])
          .filter((v): v is string => typeof v === "string")
          .join("");
      }
      return "";
    })
    .join("");
}

function sqlColumnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((col) => col.name);
}

function getChecks(table: Parameters<typeof getTableConfig>[0]): DrizzleCheck[] {
  return getTableConfig(table).checks as DrizzleCheck[];
}

// ---------------------------------------------------------------------------
// 1. All 7 IAM tables are importable from schema/index
// ---------------------------------------------------------------------------

describe("IAM tables importable from schema/index", () => {
  it("all 7 IAM tables are defined (not undefined)", () => {
    expect(principals).toBeDefined();
    expect(roles).toBeDefined();
    expect(roleGrants).toBeDefined();
    expect(grants).toBeDefined();
    expect(policies).toBeDefined();
    expect(accessRequests).toBeDefined();
    expect(iamSessions).toBeDefined();
  });

  const tables: Array<[string, Parameters<typeof getTableConfig>[0]]> = [
    ["principals", principals],
    ["roles", roles],
    ["roleGrants", roleGrants],
    ["grants", grants],
    ["policies", policies],
    ["accessRequests", accessRequests],
    ["iamSessions", iamSessions],
  ];

  for (const [name, table] of tables) {
    it(`${name} has an 'id' primary key column`, () => {
      const cols = sqlColumnNames(table);
      expect(cols).toContain("id");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. iam_sessions has no updated_at column (append-leaning policy)
// ---------------------------------------------------------------------------

describe("iam_sessions: append-leaning — no updated_at", () => {
  it("iam_sessions has no updated_at column", () => {
    const cols = sqlColumnNames(iamSessions);
    expect(cols, "iam_sessions must not carry updated_at (append-leaning)").not.toContain(
      "updated_at",
    );
  });

  it("iam_sessions has no updated_by_user_id column", () => {
    const cols = sqlColumnNames(iamSessions);
    expect(cols).not.toContain("updated_by_user_id");
  });

  it("iam_sessions has a principal_id column", () => {
    const cols = sqlColumnNames(iamSessions);
    expect(cols).toContain("principal_id");
  });

  it("iam_sessions has a revoked_at column (revocation tracking)", () => {
    const cols = sqlColumnNames(iamSessions);
    expect(cols).toContain("revoked_at");
  });
});

// ---------------------------------------------------------------------------
// 3. principals.kind CHECK constraint
// ---------------------------------------------------------------------------

describe("principals.kind CHECK constraint", () => {
  const checks = getChecks(principals);

  it("CHECK constraint name includes 'kind_check'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("kind_check")),
      `Expected a CHECK named "..._kind_check" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("kind CHECK SQL includes 'human'", () => {
    const target = checks.find((c) => c.name.includes("kind_check"));
    expect(target, "kind_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/human/);
  });

  it("kind CHECK SQL includes 'agent'", () => {
    const target = checks.find((c) => c.name.includes("kind_check"));
    expect(target, "kind_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/agent/);
  });

  it("kind CHECK SQL includes 'service'", () => {
    const target = checks.find((c) => c.name.includes("kind_check"));
    expect(target, "kind_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/service/);
  });
});

// ---------------------------------------------------------------------------
// 4. grants.effect CHECK constraint
// ---------------------------------------------------------------------------

describe("grants.effect CHECK constraint", () => {
  const checks = getChecks(grants);

  it("CHECK constraint name includes 'effect_check'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("effect_check")),
      `Expected a CHECK named "..._effect_check" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("effect CHECK SQL includes 'allow'", () => {
    const target = checks.find((c) => c.name.includes("effect_check"));
    expect(target, "effect_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/allow/);
  });

  it("effect CHECK SQL includes 'deny'", () => {
    const target = checks.find((c) => c.name.includes("effect_check"));
    expect(target, "effect_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/deny/);
  });

  it("effect CHECK SQL includes 'require_approval'", () => {
    const target = checks.find((c) => c.name.includes("effect_check"));
    expect(target, "effect_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/require_approval/);
  });
});

// ---------------------------------------------------------------------------
// 5. role_grants has org_id column
// ---------------------------------------------------------------------------

describe("role_grants columns", () => {
  it("has org_id column", () => {
    const cols = sqlColumnNames(roleGrants);
    expect(cols).toContain("org_id");
  });

  it("has role_id column", () => {
    const cols = sqlColumnNames(roleGrants);
    expect(cols).toContain("role_id");
  });

  it("has capability_id column", () => {
    const cols = sqlColumnNames(roleGrants);
    expect(cols).toContain("capability_id");
  });
});

// ---------------------------------------------------------------------------
// 6. grants has a composite index including principal_id and scope_id
// ---------------------------------------------------------------------------

describe("grants resolver hot-path index", () => {
  it("has a composite index whose columns include principal_id and scope_id", () => {
    const cfg = getTableConfig(grants);
    const compositeIndex = cfg.indexes.find((idx) => {
      const colNames = idx.config.columns
        .filter((c): c is { name: string } => typeof c === "object" && c !== null && "name" in c)
        .map((c) => c.name);
      return colNames.includes("principal_id") && colNames.includes("scope_id");
    });
    expect(
      compositeIndex,
      "Expected a composite index on (principal_id, scope_id) in grants",
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. access_requests.status CHECK constraint
// ---------------------------------------------------------------------------

describe("access_requests.status CHECK constraint", () => {
  const checks = getChecks(accessRequests);

  it("CHECK constraint name includes 'status_check'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("status_check")),
      `Expected a CHECK named "..._status_check" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("status CHECK SQL includes 'pending'", () => {
    const target = checks.find((c) => c.name.includes("status_check"));
    expect(target, "status_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/pending/);
  });

  it("status CHECK SQL includes 'approved'", () => {
    const target = checks.find((c) => c.name.includes("status_check"));
    expect(target, "status_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/approved/);
  });

  it("status CHECK SQL includes 'denied'", () => {
    const target = checks.find((c) => c.name.includes("status_check"));
    expect(target, "status_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/denied/);
  });

  it("status CHECK SQL includes 'expired'", () => {
    const target = checks.find((c) => c.name.includes("status_check"));
    expect(target, "status_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/expired/);
  });
});

// ---------------------------------------------------------------------------
// 8. roles.scope_kind CHECK constraint
// ---------------------------------------------------------------------------

describe("roles.scope_kind CHECK constraint", () => {
  const checks = getChecks(roles);

  it("CHECK constraint name includes 'scope_kind_check'", () => {
    const names = checks.map((c) => c.name);
    expect(
      names.some((n) => n.includes("scope_kind_check")),
      `Expected a CHECK named "..._scope_kind_check" but found: [${names.join(", ")}]`,
    ).toBe(true);
  });

  it("scope_kind CHECK SQL includes 'org'", () => {
    const target = checks.find((c) => c.name.includes("scope_kind_check"));
    expect(target, "scope_kind_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/org/);
  });

  it("scope_kind CHECK SQL includes 'workspace'", () => {
    const target = checks.find((c) => c.name.includes("scope_kind_check"));
    expect(target, "scope_kind_check CHECK not found").toBeDefined();
    expect(flattenCheckSql(target!)).toMatch(/workspace/);
  });
});
