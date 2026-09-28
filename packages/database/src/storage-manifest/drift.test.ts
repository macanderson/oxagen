import { describe, expect, it } from "vitest";
import { parseClickhouseSchema } from "./sources/clickhouse";
import { parseCypherSchema } from "./sources/neo4j";
import { canonicalJson, contentHashOf } from "./canonical-json";
import { driftReport, firstDifference } from "./cli";

// Drift-detection tests. `pnpm schema:manifest:check` is a byte comparison of
// the freshly generated canonical JSON against the committed file, so proving
// drift detection reduces to proving that a change to ANY input changes the
// canonical bytes + the content hash. We mutate parsed fixtures (not the real
// committed schema files) and assert the manifest body they feed changes,
// which is exactly what --check keys on.
//
// NOTE: --check IS an enforced gate. It runs in `pnpm gate`, `pnpm gate:full`
// and the pipeline `checks` job, so a stale
// packages/database/storage-manifest.json fails CI. This comment previously
// said the opposite, which is part of why a stale file survived: a reader
// checking whether it mattered was told it did not. These tests prove the
// mechanism works; they do not prove the committed file is current, which is
// what --check itself is for.

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

// ---------------------------------------------------------------------------
// What --check SAYS when it fails
// ---------------------------------------------------------------------------
//
// The report is the whole value of the gate to whoever hits it. A run that
// fails without naming the file, both values and the line where they part
// sends its reader to diff a 465 KB file by hand (#3691).

describe("driftReport", () => {
  const regenerated = canonicalJson({ version: 2, tables: ["a", "b"] });

  it("names the file, both content hashes and the first differing line", () => {
    const committed = canonicalJson({ version: 2, tables: ["a"] });
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain("packages/database/storage-manifest.json is stale");
    expect(text).toContain(
      `committed content hash:    ${contentHashOf({ version: 2, tables: ["a"] })}`,
    );
    expect(text).toContain(
      `regenerated content hash:  ${contentHashOf({ version: 2, tables: ["a", "b"] })}`,
    );
    // canonicalJson puts `"a"` on line 3; the regenerated file has `"a",`.
    const [line] = text.split("\n").filter((l) => l.includes("first difference"));
    expect(line).toBe("  first difference at line 3:");
    expect(text).toContain('committed:   "    \\"a\\""');
    expect(text).toContain('regenerated: "    \\"a\\","');
    expect(text).toContain("The content itself has drifted.");
  });

  it("names a file that kept a side's contentHash in a merge, with both values", () => {
    // The wrong resolution #3691 and #3233 describe: the body is the merged
    // one, and a committed hash from one side sits on top of it. ADR-214 took
    // the field out of the shape, so it now fails as a legacy field.
    const committed = canonicalJson({
      version: 2,
      tables: ["a", "b"],
      contentHash: "0".repeat(64),
    });
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain(
      'committed:   "  \\"contentHash\\": \\"' + "0".repeat(64) + '\\","',
    );
    expect(text).toContain(
      "The content is current, but the file still records contentHash or stores[].tableCount",
    );
    expect(text).not.toContain("The content itself has drifted.");
  });

  it("names a committed per-store tableCount as a legacy field", () => {
    const regen = canonicalJson({
      version: 2,
      stores: [{ kind: "postgres" }],
      tables: ["a"],
    });
    const committed = canonicalJson({
      version: 2,
      stores: [{ kind: "postgres", tableCount: 170 }],
      tables: ["a"],
    });
    const text = driftReport(committed, regen).join("\n");
    // The first line to differ is the one before the count, which gained a
    // trailing comma when the count was written after it.
    expect(text).toContain("first difference at line 4:");
    expect(text).toContain("still records contentHash or stores[].tableCount");
  });

  it("names a formatting-only difference", () => {
    const committed = JSON.stringify({ version: 2, tables: ["a", "b"] });
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain("only its formatting differs");
  });

  it("survives a committed file that is not JSON, such as one with merge markers", () => {
    const committed = "{\n<<<<<<< HEAD\n";
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain("not valid JSON");
    expect(text).toContain('committed:   "<<<<<<< HEAD"');
    expect(text).toContain("Run `pnpm schema:manifest`");
  });

  it("shows the end of a committed file that stops short", () => {
    // A truncated write: every line present matches, and the regenerated file
    // has one more. The report must say which side ended, not print "null".
    const committed = regenerated.trimEnd();
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain("committed:   (end of file)");
    expect(text).toContain('regenerated: ""');
    expect(text).toContain("only its formatting differs");
  });

  it("tolerates a store entry that is not an object", () => {
    // withoutDerivedScalars and carriesDerivedScalars both walk `stores`. A
    // hand-edited null there must reach the report, not throw out of the gate.
    const regen = canonicalJson({ version: 2, stores: [null], tables: ["a"] });
    const committed = JSON.stringify({
      version: 2,
      stores: [null],
      tables: ["a"],
    });
    const text = driftReport(committed, regen).join("\n");
    expect(text).toContain("only its formatting differs");
  });

  it("prints no difference lines when the texts are equal", () => {
    // `main` never calls it this way, but the report must not invent a line.
    const text = driftReport(regenerated, regenerated).join("\n");
    expect(text).not.toContain("first difference");
  });

  it("names a custom file path when given one", () => {
    const text = driftReport("{}", regenerated, "some/other.json").join("\n");
    expect(text).toContain("some/other.json is stale");
  });

  it("always ends with the command that fixes it", () => {
    for (const lines of [
      driftReport(canonicalJson({ version: 2, tables: ["a"] }), regenerated),
      driftReport("{ not json", regenerated),
    ]) {
      expect(lines.at(-1)).toContain("pnpm schema:manifest");
      expect(lines.at(-1)).toContain("regenerate from the merged tree");
    }
  });
});

describe("firstDifference", () => {
  it("returns null for equal texts", () => {
    expect(firstDifference("a\n", "a\n")).toBeNull();
  });

  it("reports the end of a shorter file as null", () => {
    expect(firstDifference("a", "a\nb")).toEqual({
      line: 2,
      committed: null,
      regenerated: "b",
    });
  });
});
