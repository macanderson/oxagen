/**
 * schema-registry.test.ts
 *
 * Smoke tests for the schema_registry Drizzle table definitions (§4.1–§4.6).
 *
 * Assertions (no live DB, no network):
 *  1.  Public-id prefixes are correct (scr, scv, sch, sca, scl, scrt, scp).
 *  3.  registries has enforcement_mode CHECK containing 'strict','lenient','off'.
 *  4.  schema_versions has status CHECK containing 'draft','published'.
 *  5.  schema_versions has NO deleted_at column (no soft delete — immutable records).
 *  6.  schemas has source CHECK containing 'user','connector','recommended'.
 *  7.  relationship_types has cardinality CHECK with 'one_to_one','one_to_many','many_to_many'.
 *  8.  properties has data_type CHECK with all 11 type values.
 *  9.  properties has an owner XOR CHECK (properties_owner_xor_check).
 *  10. properties has two unique constraints: node_label+key, rel_type+key.
 *  11. schema_activations has workspace+schema_name unique constraint.
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  schemaRegistries,
  schemaVersions,
  schemas,
  schemaActivations,
  nodeLabels,
  relationshipTypes,
  schemaProperties,
} from "../schema/schema-registry";
import { flattenCheckSql, getChecks, type DrizzleCheck } from "./_test-helpers";

// ── Helpers ──────────────────────────────────────────────────────────────────

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

function getUniqueConstraints(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).uniqueConstraints;
}

// ── 1. Table exports are defined ─────────────────────────────────────────────

// ── 2. Public-id prefixes ─────────────────────────────────────────────────────

describe("schema-registry public_id prefixes", () => {
  const cases: [string, Parameters<typeof getTableConfig>[0], string][] = [
    ["schemaRegistries", schemaRegistries, "scr"],
    ["schemaVersions", schemaVersions, "scv"],
    ["schemas", schemas, "sch"],
    ["schemaActivations", schemaActivations, "sca"],
    ["nodeLabels", nodeLabels, "scl"],
    ["relationshipTypes", relationshipTypes, "scrt"],
    ["schemaProperties", schemaProperties, "scp"],
  ];

  for (const [tableName, table, prefix] of cases) {
    it(`${tableName} public_id generates '${prefix}_…' values`, () => {
      const cfg = getTableConfig(table);
      const publicIdCol = cfg.columns.find((c) => c.name === "public_id");
      expect(
        publicIdCol,
        `${tableName} must have a public_id column`,
      ).toBeDefined();
      // Access the registered generator via the column builder's config object.
      const colBuilder = publicIdCol as unknown as {
        config: { defaultFn?: () => string };
      };
      const defaultFn = colBuilder.config.defaultFn;
      expect(
        defaultFn,
        `${tableName}.public_id must have a defaultFn`,
      ).toBeDefined();
      const id = defaultFn!();
      expect(
        id,
        `${tableName} public_id should start with '${prefix}_'`,
      ).toMatch(new RegExp(`^${prefix}_[0-9a-z]{22}$`));
    });
  }
});

// ── 3. registries — enforcement_mode CHECK ────────────────────────────────────

describe("schemaRegistries — enforcement_mode CHECK", () => {
  const checks = getChecks(schemaRegistries);
  const modeCheck = checks.find(
    (c) => c.name === "registries_enforcement_mode_check",
  );

  it("has 'registries_enforcement_mode_check' constraint", () => {
    expect(
      modeCheck,
      `Expected CHECK "registries_enforcement_mode_check"; found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  for (const val of ["strict", "lenient", "off"]) {
    it(`enforcement_mode CHECK includes '${val}'`, () => {
      const sql = flattenCheckSql(modeCheck!);
      expect(sql, `CHECK SQL: "${sql}"`).toContain(val);
    });
  }
});

// ── 3b. registries — conformance_floor column ────────────────────────────────

describe("schemaRegistries — conformance_floor column", () => {
  const cfg = getTableConfig(schemaRegistries);
  const col = cfg.columns.find((c) => c.name === "conformance_floor");

  it("has a conformance_floor column", () => {
    expect(col).toBeDefined();
  });
  it("conformance_floor is NOT NULL", () => {
    expect(col?.notNull).toBe(true);
  });
});

// ── 4. schema_versions — status CHECK ────────────────────────────────────────

describe("schemaVersions — status CHECK", () => {
  const checks = getChecks(schemaVersions);
  const statusCheck = checks.find(
    (c) => c.name === "schema_versions_status_check",
  );

  it("has 'schema_versions_status_check' constraint", () => {
    expect(
      statusCheck,
      `Expected CHECK "schema_versions_status_check"; found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  for (const val of ["draft", "published"]) {
    it(`status CHECK includes '${val}'`, () => {
      const sql = flattenCheckSql(statusCheck!);
      expect(sql, `CHECK SQL: "${sql}"`).toContain(val);
    });
  }
});

// ── 5. schema_versions — no soft delete ──────────────────────────────────────

describe("schemaVersions — no soft delete (immutable records)", () => {
  it("does NOT have a deleted_at column", () => {
    const cols = columnNames(schemaVersions);
    expect(
      cols,
      "schema_versions must NOT have deleted_at (published versions are immutable)",
    ).not.toContain("deleted_at");
  });
});

// ── 6. schemas — source CHECK ────────────────────────────────────────────────

describe("schemas — source CHECK", () => {
  const checks = getChecks(schemas);
  const sourceCheck = checks.find((c) => c.name === "schemas_source_check");

  it("has 'schemas_source_check' constraint", () => {
    expect(
      sourceCheck,
      `Expected CHECK "schemas_source_check"; found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  for (const val of ["user", "connector", "recommended"]) {
    it(`source CHECK includes '${val}'`, () => {
      const sql = flattenCheckSql(sourceCheck!);
      expect(sql, `CHECK SQL: "${sql}"`).toContain(val);
    });
  }
});

// ── 7. relationship_types — cardinality CHECK ─────────────────────────────────

describe("relationshipTypes — cardinality CHECK", () => {
  const checks = getChecks(relationshipTypes);
  const cardCheck = checks.find(
    (c) => c.name === "relationship_types_cardinality_check",
  );

  it("has 'relationship_types_cardinality_check' constraint", () => {
    expect(
      cardCheck,
      `Expected CHECK "relationship_types_cardinality_check"; found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  for (const val of ["one_to_one", "one_to_many", "many_to_many"]) {
    it(`cardinality CHECK includes '${val}'`, () => {
      const sql = flattenCheckSql(cardCheck!);
      expect(sql, `CHECK SQL: "${sql}"`).toContain(val);
    });
  }
});

// ── 8. properties — data_type CHECK ──────────────────────────────────────────

const PROPERTY_DATA_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "enum",
  "json",
  "array",
] as const;

describe("schemaProperties — data_type CHECK", () => {
  const checks = getChecks(schemaProperties);
  const dtCheck = checks.find((c) => c.name === "properties_data_type_check");

  it("has 'properties_data_type_check' constraint", () => {
    expect(
      dtCheck,
      `Expected CHECK "properties_data_type_check"; found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  for (const val of PROPERTY_DATA_TYPES) {
    it(`data_type CHECK includes '${val}'`, () => {
      const sql = flattenCheckSql(dtCheck!);
      expect(sql, `CHECK SQL: "${sql}"`).toContain(val);
    });
  }

  it("PROPERTY_DATA_TYPES has exactly 11 values (no drift)", () => {
    expect(PROPERTY_DATA_TYPES).toHaveLength(11);
  });
});

// ── 9. properties — XOR owner CHECK ──────────────────────────────────────────

describe("schemaProperties — owner XOR CHECK", () => {
  const checks = getChecks(schemaProperties);
  const xorCheck = checks.find((c) => c.name === "properties_owner_xor_check");

  it("has 'properties_owner_xor_check' constraint", () => {
    expect(
      xorCheck,
      `Expected CHECK "properties_owner_xor_check"; found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  it("XOR CHECK SQL references node_label_id", () => {
    const sql = flattenCheckSql(xorCheck!);
    expect(sql).toContain("node_label_id");
  });

  it("XOR CHECK SQL references relationship_type_id", () => {
    const sql = flattenCheckSql(xorCheck!);
    expect(sql).toContain("relationship_type_id");
  });
});

// ── 10. properties — unique constraints ───────────────────────────────────────

describe("schemaProperties — unique constraints", () => {
  const cfg = getTableConfig(schemaProperties);
  const uniques = cfg.uniqueConstraints;

  it("has unique constraint 'properties_node_label_key_uniq'", () => {
    const found = uniques.find(
      (u) => u.name === "properties_node_label_key_uniq",
    );
    expect(
      found,
      `Expected unique "properties_node_label_key_uniq"; found: [${uniques.map((u) => u.name).join(", ")}]`,
    ).toBeDefined();
  });

  it("has unique constraint 'properties_rel_type_key_uniq'", () => {
    const found = uniques.find(
      (u) => u.name === "properties_rel_type_key_uniq",
    );
    expect(
      found,
      `Expected unique "properties_rel_type_key_uniq"; found: [${uniques.map((u) => u.name).join(", ")}]`,
    ).toBeDefined();
  });
});

// ── 11. schema_activations — workspace+schema_name unique constraint ───────────

describe("schemaActivations — workspace+schema_name unique", () => {
  const cfg = getTableConfig(schemaActivations);
  const uniques = cfg.uniqueConstraints;

  it("has unique constraint 'schema_activations_workspace_schema_uniq'", () => {
    const found = uniques.find(
      (u) => u.name === "schema_activations_workspace_schema_uniq",
    );
    expect(
      found,
      `Expected unique "schema_activations_workspace_schema_uniq"; found: [${uniques.map((u) => u.name).join(", ")}]`,
    ).toBeDefined();
  });
});
