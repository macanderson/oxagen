import { describe, expect, it } from "vitest";
import { parseClickhouseSchema } from "./sources/clickhouse";
import { parseCypherSchema } from "./sources/neo4j";
import { canonicalJson, contentHashOf } from "./canonical-json";

// Drift-detection tests. `pnpm schema:manifest:check` is a byte comparison of
// the freshly generated canonical JSON against the committed file, so proving
// drift detection reduces to proving that a change to ANY input changes the
// canonical bytes + the content hash. We mutate parsed fixtures (not the real
// committed schema files) and assert the manifest body they feed changes,
// which is exactly what --check keys on.
//
// NOTE: --check is a script an author can run, not an enforced gate. It is not
// in `pnpm gate`, `pnpm gate:full`, or any workflow in .github/workflows, so
// nothing fails when packages/database/storage-manifest.json goes stale. These
// tests prove the mechanism works; they do not prove the committed file is
// current.

const CH_BASE = `
  CREATE TABLE IF NOT EXISTS token_usage (
    org_id UUID,
    model LowCardinality(String)
  ) ENGINE = MergeTree() ORDER BY (org_id);
`;

const CYPHER_BASE = `
  CREATE CONSTRAINT execution_public_id IF NOT EXISTS FOR (n:Execution) REQUIRE n.publicId IS UNIQUE;
  CREATE INDEX execution_org IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
`;

/** Render a fixture's parsed tables the way the manifest body would. */
function bodyHash(tables: unknown): string {
  return contentHashOf({ contentHash: "", tables } as Record<string, unknown>);
}

describe("drift detection — a changed input changes the content hash", () => {
  it("adding a ClickHouse column changes the hash", () => {
    const before = parseClickhouseSchema(CH_BASE);
    const mutated = CH_BASE.replace(
      "model LowCardinality(String)",
      "model LowCardinality(String),\n    new_col UInt64",
    );
    const after = parseClickhouseSchema(mutated);
    expect(after[0]?.columns.length).toBe((before[0]?.columns.length ?? 0) + 1);
    expect(bodyHash(after)).not.toBe(bodyHash(before));
  });

  it("renaming a ClickHouse column changes the hash", () => {
    const before = parseClickhouseSchema(CH_BASE);
    const after = parseClickhouseSchema(
      CH_BASE.replace("model ", "model_name "),
    );
    expect(bodyHash(after)).not.toBe(bodyHash(before));
  });

  it("changing a ClickHouse TTL changes the hash", () => {
    const withTtl = CH_BASE.replace(
      "ORDER BY (org_id);",
      "ORDER BY (org_id) TTL toDateTime(created_at) + INTERVAL 90 DAY;",
    );
    const before = parseClickhouseSchema(withTtl);
    const after = parseClickhouseSchema(withTtl.replace("90 DAY", "365 DAY"));
    expect(before[0]?.meta?.ttl).toContain("90 DAY");
    expect(after[0]?.meta?.ttl).toContain("365 DAY");
    expect(bodyHash(after)).not.toBe(bodyHash(before));
  });

  it("adding a Neo4j index changes the hash", () => {
    const before = parseCypherSchema(CYPHER_BASE);
    const after = parseCypherSchema(
      CYPHER_BASE +
        "\nCREATE INDEX execution_status IF NOT EXISTS FOR (n:Execution) ON (n.status);",
    );
    expect(bodyHash(after)).not.toBe(bodyHash(before));
  });

  it("an unchanged input yields a byte-identical hash (no false drift)", () => {
    const a = parseClickhouseSchema(CH_BASE);
    const b = parseClickhouseSchema(CH_BASE);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(bodyHash(a)).toBe(bodyHash(b));
  });
});
