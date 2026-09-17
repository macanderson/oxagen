import { describe, expect, it } from "vitest";
import { recordHash, recordPreimage } from "./record-hash";

// The golden directive record and its digest are copied from Stella's
// stella-protocol/src/hash.rs (`golden_directive_record_hash_is_stable`), so a
// drift on either side shows up as a mismatch on this exact value.
const GOLDEN_DIRECTIVE = {
  schema_version: "1.0-draft",
  record_kind: "directive",
  record_id: "dir_example_v1",
  lineage_id: "lin_example",
  directive_kind: "rule",
  origin: "inferred",
  enforcement: "advisory",
  confidence: 88,
  scope: { repository_id: "repo_1" },
  sharing_scope: "repository",
  observed_at: "2026-07-20T18:30:00Z",
  valid_from: "2026-07-20T18:30:00Z",
  record_hash:
    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
};
const GOLDEN_DIRECTIVE_HASH =
  "sha256:761d3d24d908aa31946a09d2fab3ab329c7504cfdb508b5f7d4832d23bd18499";

describe("recordHash", () => {
  it("matches Stella's golden directive preimage and digest", () => {
    expect(recordPreimage(GOLDEN_DIRECTIVE)).toBe(
      '{"confidence":88,"directive_kind":"rule","enforcement":"advisory","lineage_id":"lin_example","observed_at":"2026-07-20T18:30:00Z","origin":"inferred","record_id":"dir_example_v1","record_kind":"directive","schema_version":"1.0-draft","scope":{"repository_id":"repo_1"},"sharing_scope":"repository","valid_from":"2026-07-20T18:30:00Z"}',
    );
    expect(recordHash(GOLDEN_DIRECTIVE)).toBe(GOLDEN_DIRECTIVE_HASH);
  });

  it("sorts keys, drops record_hash and omits null members (Stella's pipeline vector)", () => {
    expect(
      recordPreimage({
        b_num: 88,
        a_str: "x",
        nested: { y: "2", x: "1" },
        z_null: null,
        record_hash: "sha256:deadbeef",
      }),
    ).toBe('{"a_str":"x","b_num":88,"nested":{"x":"1","y":"2"}}');
  });

  it("treats an explicit null as absent at every depth, and keeps a null array element", () => {
    expect(recordHash({ a: 1 })).toBe(recordHash({ a: 1, b: null }));
    expect(recordPreimage({ outer: { a: 1, b: null } })).toBe(
      '{"outer":{"a":1}}',
    );
    expect(recordPreimage({ items: [{ a: 1, b: null }] })).toBe(
      '{"items":[{"a":1}]}',
    );
    expect(recordPreimage({ items: [null, 1] })).toBe('{"items":[null,1]}');
  });

  it("is independent of key order and of a pre-existing record_hash", () => {
    expect(recordHash({ a: 1, b: 2 })).toBe(recordHash({ b: 2, a: 1 }));
    expect(recordHash({ a: 1 })).toBe(
      recordHash({ a: 1, record_hash: "sha256:0000" }),
    );
  });
});
