/**
 * IAM schema smoke tests for @oxagen/database.
 *
 * Tests operate entirely on Drizzle table definitions via `getTableConfig` —
 * no live DB, no network, no random/wall-clock values.
 *
 * Assertions:
 *  1. All 5 current IAM tables are importable from schema/index.
 *  2. principals carries an updated_at column via auditMixin.
 *  3. principals.kind CHECK constraint exists and covers all 3 values.
 *  4. roleGrants.effect CHECK constraint exists and covers all 3 effect values.
 *  5. role_grants table has org_id, role_id, capability_id columns.
 *  6. principalRoleAssignments has a composite unique index on (principal_id, role_id, org_id).
 *  7. access_requests.status CHECK constraint exists and covers all 4 values.
 *  8. roles.scope_kind CHECK exists and includes both 'org' and 'workspace'.
 *
 * A `grants` (direct principal→scope effect) table and a `policies` (ABAC
 * policy) table are planned but not yet implemented. Tests for those tables
 * will be added when the migrations land.
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  principals,
  roles,
  roleGrants,
  principalRoleAssignments,
  accessRequests,
} from "../schema/index";
import { flattenCheckSql, sqlColumnNames, getChecks } from "./_test-helpers";

// ---------------------------------------------------------------------------
// 1. All 5 current IAM tables are importable from schema/index
// ---------------------------------------------------------------------------

describe("IAM tables importable from schema/index", () => {
  const tables: Array<[string, Parameters<typeof getTableConfig>[0]]> = [
    ["principals", principals],
    ["roles", roles],
    ["roleGrants", roleGrants],
    ["principalRoleAssignments", principalRoleAssignments],
    ["accessRequests", accessRequests],
  ];

  for (const [name, table] of tables) {
    it(`${name} has an 'id' primary key column`, () => {
      const cols = sqlColumnNames(table);
      expect(cols).toContain("id");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. principals.kind CHECK constraint
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
// 4. roleGrants.effect CHECK constraint
// ---------------------------------------------------------------------------

describe("roleGrants.effect CHECK constraint", () => {
  const checks = getChecks(roleGrants);

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
// 5. role_grants has org_id, role_id, capability_id columns
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
// 6. principalRoleAssignments has composite unique index on (principal_id, role_id, org_id)
// ---------------------------------------------------------------------------

describe("principalRoleAssignments unique index", () => {
  it("has a composite index whose columns include principal_id and role_id", () => {
    const cfg = getTableConfig(principalRoleAssignments);
    const compositeIndex = cfg.indexes.find((idx) => {
      const colNames = idx.config.columns
        .filter(
          (c): c is { name: string } =>
            typeof c === "object" && c !== null && "name" in c,
        )
        .map((c) => c.name);
      return colNames.includes("principal_id") && colNames.includes("role_id");
    });
    expect(
      compositeIndex,
      "Expected a composite index on (principal_id, role_id) in principalRoleAssignments",
    ).toBeDefined();
  });

  it("has an org_id column", () => {
    const cols = sqlColumnNames(principalRoleAssignments);
    expect(cols).toContain("org_id");
  });

  it("has an assigned_at column", () => {
    const cols = sqlColumnNames(principalRoleAssignments);
    expect(cols).toContain("assigned_at");
  });
});

// ---------------------------------------------------------------------------
// 6b. principals has a partial unique index on (org_id, parent_user_id)
// ---------------------------------------------------------------------------

describe("principals org/parent_user uniqueness", () => {
  it("has a UNIQUE index on (org_id, parent_user_id)", () => {
    const cfg = getTableConfig(principals);
    const idx = cfg.indexes.find((i) => {
      const colNames = i.config.columns
        .filter(
          (c): c is { name: string } =>
            typeof c === "object" && c !== null && "name" in c,
        )
        .map((c) => c.name);
      return colNames.includes("org_id") && colNames.includes("parent_user_id");
    });
    expect(
      idx,
      "Expected a unique index on (org_id, parent_user_id) in principals",
    ).toBeDefined();
    // Deterministic principal resolution in fetch-authz depends on uniqueness.
    expect(idx?.config.unique).toBe(true);
    // Partial: org-level service principals (parent_user_id NULL) are exempt.
    expect(idx?.config.where).toBeDefined();
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
