/**
 * Property-based tests for content addressing invariants.
 *
 * These tests validate the fundamental guarantees of the content-addressed
 * record system at scale — the properties that must NEVER break:
 * 1. Determinism: same input → same ID, always
 * 2. Uniqueness: different input → different ID (with overwhelming probability)
 * 3. Integrity: tampered records are always detected
 */
import { describe, it, expect } from "vitest";
import { computeRecordId, createRecord, verifyRecordIntegrity } from "./record";
import type { Namespace, Provenance, EpisodicBody } from "./types";

const ns: Namespace = { org: "prop-org", workspace: "prop-ws" };
const provenance: Provenance = {
  author: "property-test",
  derivedFrom: [],
  timestamp: 1700000000000,
};

describe("content addressing properties", () => {
  it("determinism: 100 identical inputs produce identical IDs", () => {
    const body: EpisodicBody = { event: "stable", payload: { n: 42 } };
    const ids = Array.from({ length: 100 }, () =>
      computeRecordId("episodic", ns, body),
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(1);
  });

  it("uniqueness: 100 different inputs produce 100 different IDs", () => {
    const ids = Array.from({ length: 100 }, (_, i) =>
      computeRecordId("episodic", ns, { event: `event-${i}`, payload: { i } }),
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(100);
  });

  it("namespace sensitivity: same body in different orgs → different IDs", () => {
    const body: EpisodicBody = { event: "shared", payload: {} };
    const ids = Array.from({ length: 10 }, (_, i) =>
      computeRecordId("episodic", { org: `org-${i}`, workspace: "ws" }, body),
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(10);
  });

  it("kind sensitivity: same body with different kinds → different IDs", () => {
    const body = { event: "test", payload: {} };
    const kinds = [
      "episodic",
      "semantic",
      "procedural",
      "entity",
      "edge",
    ] as const;
    const ids = kinds.map((k) => computeRecordId(k, ns, body));
    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });

  it("integrity: any field mutation is detected", () => {
    const body: EpisodicBody = { event: "original", payload: { x: 1 } };
    const record = createRecord({
      kind: "episodic",
      namespace: ns,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });

    // Untampered → valid
    expect(verifyRecordIntegrity(record)).toBe(true);

    // Tamper body
    expect(
      verifyRecordIntegrity({
        ...record,
        body: { event: "tampered", payload: { x: 1 } },
      }),
    ).toBe(false);

    // Tamper kind
    expect(verifyRecordIntegrity({ ...record, kind: "semantic" })).toBe(false);

    // Tamper namespace
    expect(
      verifyRecordIntegrity({ ...record, namespace: { ...ns, org: "hacked" } }),
    ).toBe(false);

    // Tamper ID directly
    expect(verifyRecordIntegrity({ ...record, id: "0".repeat(64) })).toBe(
      false,
    );
  });

  it("metadata changes don't affect ID (salience, confidence, provenance)", () => {
    const body: EpisodicBody = { event: "stable-id", payload: {} };
    // Pin createdAt so occurrence is held constant — the ONLY difference between
    // the two records is metadata, which must not change the ID.
    const at = 1700000000000;
    const r1 = createRecord({
      kind: "episodic",
      namespace: ns,
      body,
      salience: 0.1,
      confidence: 0.5,
      provenance,
      createdAt: at,
    });
    const r2 = createRecord({
      kind: "episodic",
      namespace: ns,
      body,
      salience: 0.9,
      confidence: 1.0,
      provenance: { ...provenance, author: "different" },
      createdAt: at,
    });
    expect(r1.id).toBe(r2.id);
  });

  it("P1-5: back-to-back identical episodic events get DISTINCT IDs", () => {
    // Two genuinely-separate occurrences of the same event must not alias to a
    // single record — the process-monotonic occurrence discriminator keeps them
    // distinct even without an explicit createdAt.
    const body: EpisodicBody = {
      event: "tool_call",
      payload: { name: "search" },
    };
    const a = createRecord({
      kind: "episodic",
      namespace: ns,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });
    const b = createRecord({
      kind: "episodic",
      namespace: ns,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).not.toBe(b.createdAt);
  });

  it("P1-5: non-episodic kinds still dedupe by content (same body → same ID)", () => {
    // Semantic/procedural/entity/edge remain content-addressed: identical
    // content collapses to one record regardless of when it's written.
    const semanticBody = { fact: "auth uses better-auth", domain: "auth" };
    const s1 = createRecord({
      kind: "semantic",
      namespace: ns,
      body: semanticBody,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });
    const s2 = createRecord({
      kind: "semantic",
      namespace: ns,
      body: semanticBody,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });
    expect(s1.id).toBe(s2.id);
  });

  it("P1-6: identical content with different key order hashes the same", () => {
    // Canonical (sorted-key) serialization: key insertion order must not change
    // the ID, or the same fact from two code paths would land as two records.
    const id1 = computeRecordId("semantic", ns, {
      fact: "x",
      domain: "d",
    } as never);
    const id2 = computeRecordId("semantic", ns, {
      domain: "d",
      fact: "x",
    } as never);
    expect(id1).toBe(id2);
  });

  it("all IDs are exactly 64 hex characters", () => {
    for (let i = 0; i < 50; i++) {
      const id = computeRecordId(
        "episodic",
        { org: `o${i}`, workspace: `w${i}` },
        { event: `e${i}`, payload: { data: `value-${i}` } },
      );
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
