import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildManifest, renderManifest, MANIFEST_VERSION } from "./generate";
import { canonicalJson, canonicalize, contentHashOf } from "./canonical-json";
import { collectPostgresTables } from "./sources/postgres";
import { parseClickhouseSchema } from "./sources/clickhouse";
import { parseCypherSchema } from "./sources/neo4j";
import { GENERATED_ASSET_KINDS, collectBlobAssets } from "./sources/blob";
import { PG_DOMAINS } from "./domains";

// The 22 Postgres schema domains declared in schema/_schemas.ts. The manifest
// must surface every one of these as a domain — this is the coverage contract.
const EXPECTED_PG_SCHEMAS = [
  "agent",
  "ai",
  "auth",
  "billing",
  "chat",
  "cms",
  "content",
  "environments",
  "eval",
  "evidence",
  "iam",
  "ingestion",
  "mcp",
  "notification",
  "org",
  "plugin",
  "privacy",
  "ratelimit",
  "schema_registry",
  "security",
  "workflow",
  "workspace",
] as const;

describe("canonical-json", () => {
  it("sorts object keys at every level, arrays kept in place", () => {
    const input = { b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } };
    const json = canonicalJson(input);
    expect(json).toBe(
      '{\n  "a": {\n    "c": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ],\n    "d": 2\n  },\n  "b": 1\n}\n',
    );
  });

  it("canonicalize is idempotent", () => {
    const input = { b: [3, 1, 2], a: "x" };
    expect(canonicalize(canonicalize(input))).toEqual(canonicalize(input));
  });

  it("contentHashOf excludes the hash field itself", () => {
    const body = { version: 1, contentHash: "STALE", data: [1, 2, 3] };
    const { contentHash: _omit, ...rest } = body;
    const expected = createHash("sha256")
      .update(canonicalJson(rest))
      .digest("hex");
    expect(contentHashOf(body)).toBe(expected);
    // The stored (possibly-stale) hash value must not affect the result.
    expect(contentHashOf({ ...body, contentHash: "DIFFERENT" })).toBe(expected);
  });
});

describe("storage manifest — determinism", () => {
  it("two builds produce byte-identical JSON", () => {
    expect(renderManifest()).toBe(renderManifest());
  });

  it("the content hash matches a fresh hash of the canonical body", () => {
    const m = buildManifest();
    const { contentHash, ...body } = m;
    expect(contentHash).toBe(contentHashOf({ contentHash, ...body }));
    // And re-hashing the emitted body reproduces it exactly.
    expect(contentHash).toBe(
      createHash("sha256").update(canonicalJson(body)).digest("hex"),
    );
  });

  it("declares the current manifest version", () => {
    expect(buildManifest().version).toBe(MANIFEST_VERSION);
  });
});

describe("storage manifest — coverage snapshot", () => {
  const manifest = buildManifest();

  it("surfaces every Postgres schema as a domain", () => {
    const domainNames = new Set(manifest.domains.map((d) => d.name));
    for (const schema of EXPECTED_PG_SCHEMAS) {
      expect(domainNames.has(schema)).toBe(true);
    }
  });

  it("PG_DOMAINS matches the expected schema list", () => {
    expect([...PG_DOMAINS].sort()).toEqual([...EXPECTED_PG_SCHEMAS].sort());
  });

  it("Postgres table count matches the Drizzle schema object count", () => {
    const pgTables = manifest.tables.filter((t) => t.store === "postgres");
    expect(pgTables.length).toBe(collectPostgresTables().length);
    // Guard against a schema-barrel regression silently emptying the manifest.
    expect(pgTables.length).toBeGreaterThan(100);
  });

  it("includes all four stores, each with tables", () => {
    const kinds = manifest.stores.map((s) => s.kind).sort();
    expect(kinds).toEqual(["blob", "clickhouse", "neo4j", "postgres"]);
    for (const store of manifest.stores) {
      expect(store.tableCount).toBeGreaterThan(0);
    }
  });

  it("every table has a store-qualified id and a domain", () => {
    for (const t of manifest.tables) {
      expect(t.id).toMatch(/^(postgres|clickhouse|neo4j|blob):/);
      expect(t.domain.length).toBeGreaterThan(0);
    }
  });

  it("tables and capabilities are sorted (canonical order)", () => {
    const ids = manifest.tables.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
    const caps = manifest.capabilities.map((c) => c.name);
    expect(caps).toEqual([...caps].sort());
  });

  it("tenant-scoped Postgres tables carry an RLS policy class", () => {
    for (const t of manifest.tables) {
      if (t.store === "postgres" && t.tenantScoped) {
        expect(t.rls).toBeDefined();
      }
    }
  });
});

describe("storage manifest — Postgres source", () => {
  const tables = collectPostgresTables();

  it("resolves foreign-key references to target table ids", () => {
    const steps = tables.find(
      (t) => t.id === "postgres:agent.agent_execution_steps",
    );
    expect(steps).toBeDefined();
    const fk = steps?.columns.find((c) => c.name === "execution_id");
    expect(fk?.references).toBe("postgres:agent.agent_executions");
  });

  it("marks primary-key columns and nullability", () => {
    const invoices = tables.find((t) => t.id === "postgres:billing.invoices");
    const idCol = invoices?.columns.find((c) => c.name === "id");
    expect(idCol?.primaryKey).toBe(true);
    expect(idCol?.nullable).toBe(false);
  });

  it("joins the tenant-policy RLS class onto owned tables", () => {
    const invoices = tables.find((t) => t.id === "postgres:billing.invoices");
    expect(invoices?.tenantScoped).toBe(true);
    expect(invoices?.rls).toBe("org_only");
  });
});

describe("storage manifest — ClickHouse parser", () => {
  const DDL = `
    -- a comment
    CREATE TABLE IF NOT EXISTS token_usage (
      execution_step_id UUID,
      org_id UUID,
      model LowCardinality(String),
      cost_usd_micros UInt64 CODEC(T64, ZSTD(1)),
      note Nullable(String) DEFAULT '',
      metrics Map(LowCardinality(String), Float64),
      created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
      INDEX idx_token_model model TYPE set(0) GRANULARITY 4
    ) ENGINE = MergeTree()
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (org_id, created_at)
    TTL toDateTime(created_at) + INTERVAL 365 DAY;

    CREATE TABLE IF NOT EXISTS eval_runs (
      run_id String,
      resolved_rate Float64 DEFAULT 0
    ) ENGINE = ReplacingMergeTree(updated_at)
    ORDER BY (run_id);
  `;

  it("parses tables, columns, engine, ttl — skipping INDEX rows", () => {
    const tables = parseClickhouseSchema(DDL);
    expect(tables.map((t) => t.name).sort()).toEqual([
      "eval_runs",
      "token_usage",
    ]);
    const tu = tables.find((t) => t.name === "token_usage");
    expect(tu?.columns.map((c) => c.name)).toEqual([
      "execution_step_id",
      "org_id",
      "model",
      "cost_usd_micros",
      "note",
      "metrics",
      "created_at",
    ]);
    // No INDEX line leaks in as a column.
    expect(tu?.columns.some((c) => c.name.startsWith("INDEX"))).toBe(false);
  });

  it("strips CODEC/DEFAULT from types and keeps nested-paren types intact", () => {
    const tables = parseClickhouseSchema(DDL);
    const tu = tables.find((t) => t.name === "token_usage");
    const cost = tu?.columns.find((c) => c.name === "cost_usd_micros");
    expect(cost?.type).toBe("UInt64");
    const metrics = tu?.columns.find((c) => c.name === "metrics");
    expect(metrics?.type).toBe("Map(LowCardinality(String), Float64)");
  });

  it("marks Nullable(...) columns nullable, others not", () => {
    const tables = parseClickhouseSchema(DDL);
    const tu = tables.find((t) => t.name === "token_usage");
    expect(tu?.columns.find((c) => c.name === "note")?.nullable).toBe(true);
    expect(tu?.columns.find((c) => c.name === "org_id")?.nullable).toBe(false);
  });

  it("captures engine / partitionBy / orderBy / ttl in meta", () => {
    const tables = parseClickhouseSchema(DDL);
    const tu = tables.find((t) => t.name === "token_usage");
    expect(tu?.meta?.engine).toBe("MergeTree()");
    expect(tu?.meta?.partitionBy).toBe("toYYYYMM(created_at)");
    expect(tu?.meta?.orderBy).toBe("(org_id, created_at)");
    expect(tu?.meta?.ttl).toContain("INTERVAL 365 DAY");
    // eval_runs has no TTL — meta.ttl must be absent, not empty.
    const er = tables.find((t) => t.name === "eval_runs");
    expect(er?.meta?.ttl).toBeUndefined();
    expect(er?.meta?.engine).toBe("ReplacingMergeTree(updated_at)");
  });

  it("marks a table tenant-scoped iff it has an org_id column", () => {
    const tables = parseClickhouseSchema(DDL);
    expect(tables.find((t) => t.name === "token_usage")?.tenantScoped).toBe(
      true,
    );
    expect(tables.find((t) => t.name === "eval_runs")?.tenantScoped).toBe(
      false,
    );
  });
});

describe("storage manifest — Neo4j parser", () => {
  const CYPHER = `
    CREATE CONSTRAINT execution_public_id IF NOT EXISTS FOR (n:Execution) REQUIRE n.publicId IS UNIQUE;
    CREATE CONSTRAINT source_file_natural_key_org_unique IF NOT EXISTS
      FOR (n:SourceFile) REQUIRE (n.naturalKey, n.orgId) IS UNIQUE;
    CREATE INDEX execution_org IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
    CREATE VECTOR INDEX execution_embedding_index IF NOT EXISTS FOR (n:Execution) ON (n.embedding);
    CREATE VECTOR INDEX execution_embedding_index IF NOT EXISTS FOR (n:Execution) ON (n.embedding);
    MATCH (n:KnowledgeNode) SET n:GraphNode REMOVE n:KnowledgeNode;
  `;

  it("parses labels, properties, constraints and indexes", () => {
    const tables = parseCypherSchema(CYPHER);
    expect(tables.map((t) => t.name).sort()).toEqual([
      "Execution",
      "SourceFile",
    ]);
    const ex = tables.find((t) => t.name === "Execution");
    expect(ex?.columns.map((c) => c.name).sort()).toEqual([
      "embedding",
      "orgId",
      "publicId",
    ]);
    expect(ex?.meta?.constraints).toBe("execution_public_id");
    expect(ex?.meta?.indexes).toBe("execution_org");
  });

  it("dedupes a repeated index so the hash is stable", () => {
    const tables = parseCypherSchema(CYPHER);
    const ex = tables.find((t) => t.name === "Execution");
    // execution_embedding_index appears twice in the DDL — one entry expected.
    expect(ex?.meta?.vectorIndexes).toBe("execution_embedding_index");
  });

  it("marks a label tenant-scoped when an index/constraint references orgId", () => {
    const tables = parseCypherSchema(CYPHER);
    expect(tables.find((t) => t.name === "Execution")?.tenantScoped).toBe(true);
    expect(tables.find((t) => t.name === "SourceFile")?.tenantScoped).toBe(
      true,
    );
  });

  it("ignores the trailing MATCH ... SET data-migration statements", () => {
    const tables = parseCypherSchema(CYPHER);
    // KnowledgeNode / GraphNode from the relabel MATCH must not become labels.
    expect(tables.some((t) => t.name === "KnowledgeNode")).toBe(false);
    expect(tables.some((t) => t.name === "GraphNode")).toBe(false);
  });
});

describe("storage manifest — blob source", () => {
  it("covers exactly the generated_assets CHECK-constraint kinds", () => {
    const blob = collectBlobAssets();
    const generated = blob.find((t) => t.name === "generated_asset");
    const kinds = generated?.meta?.assetKinds?.split(",").sort() ?? [];
    expect(kinds).toEqual([...GENERATED_ASSET_KINDS].sort());
  });

  it("maps each asset kind to its referencing Postgres table(s)", () => {
    const blob = collectBlobAssets();
    const avatar = blob.find((t) => t.name === "avatar");
    expect(avatar?.meta?.referencedBy).toContain("postgres:auth.users");
    const generated = blob.find((t) => t.name === "generated_asset");
    expect(generated?.meta?.referencedBy).toBe(
      "postgres:content.generated_assets",
    );
  });
});
