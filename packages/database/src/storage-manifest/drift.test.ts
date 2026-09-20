import { describe, expect, it } from "vitest";
import { parseClickhouseSchema } from "./sources/clickhouse";
import { parseCypherSchema } from "./sources/neo4j";
import { canonicalJson, contentHashOf } from "./canonical-json";
import { driftReport } from "./cli";

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
// fails without naming which of the two things differs sends its reader to
// diff a 465 KB file by hand.

describe("driftReport", () => {
  /** A committed file whose body is current and whose recorded hash is not. */
  function staleFieldOnly(): { committed: string; regenerated: string } {
    const body = { tables: ["a", "b"], contentHash: "" };
    const regenerated = contentHashOf(body as Record<string, unknown>);
    return {
      committed: canonicalJson({ ...body, contentHash: "0".repeat(64) }),
      regenerated,
    };
  }

  it("names the stale-field case instead of printing two equal hashes", () => {
    // The case that blocked the app cutover (ADR-081): the body was current,
    // the recorded field was not, and the old report printed the recomputed
    // hash twice with nothing to distinguish it from a broken check.
    const { committed, regenerated } = staleFieldOnly();
    const lines = driftReport(committed, regenerated);
    const text = lines.join("\n");
    expect(text).toContain(
      "The body is current; only the recorded contentHash field is stale.",
    );
    expect(text).not.toContain("The body itself has drifted.");
  });

  it("prints the recorded field and the recomputed hash as different numbers", () => {
    // Both are reported, so the reader can see WHICH one is wrong. Printing
    // only the recomputed value is what hid this.
    const { committed, regenerated } = staleFieldOnly();
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain("0".repeat(64));
    expect(text).toContain(regenerated);
  });

  it("names the body case when the content itself moved", () => {
    const committed = canonicalJson({
      tables: ["a"],
      contentHash: contentHashOf({ tables: ["a"], contentHash: "" }),
    });
    const regenerated = contentHashOf({
      tables: ["a", "b"],
      contentHash: "",
    } as Record<string, unknown>);
    const text = driftReport(committed, regenerated).join("\n");
    expect(text).toContain("The body itself has drifted.");
    expect(text).not.toContain("only the recorded contentHash field is stale");
  });

  it("survives a committed file that is not JSON at all", () => {
    // A truncated write or a merge marker must report something a reader can
    // act on rather than throwing out of the gate.
    const text = driftReport("{ not json", "abc").join("\n");
    expect(text).toContain("not valid JSON");
    expect(text).toContain("Run `pnpm schema:manifest`");
  });

  it("reports an absent contentHash field rather than an empty line", () => {
    const committed = canonicalJson({ tables: ["a"] });
    const text = driftReport(committed, "abc").join("\n");
    expect(text).toContain("(absent)");
  });

  it("always ends with the command that fixes it", () => {
    const { committed, regenerated } = staleFieldOnly();
    for (const lines of [
      driftReport(committed, regenerated),
      driftReport("{ not json", "abc"),
    ]) {
      expect(lines.at(-1)).toContain("pnpm schema:manifest");
    }
  });
});
