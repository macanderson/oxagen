import { describe, it, expect } from "vitest";
import { computeRecordId, createRecord, verifyRecordIntegrity } from "./record";
import type {
  Namespace,
  Provenance,
  EpisodicBody,
  SemanticBody,
} from "./types";

const namespace: Namespace = { org: "org-1", workspace: "ws-1" };
const provenance: Provenance = {
  author: "agent-test",
  derivedFrom: [],
  timestamp: 1700000000000,
};

describe("computeRecordId", () => {
  it("produces a 64-char hex string", () => {
    const body: EpisodicBody = { event: "test", payload: { foo: "bar" } };
    const id = computeRecordId("episodic", namespace, body);
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("identical content produces identical ID (dedup property)", () => {
    const body: EpisodicBody = {
      event: "tool_call",
      payload: { name: "grep" },
    };
    const id1 = computeRecordId("episodic", namespace, body);
    const id2 = computeRecordId("episodic", namespace, body);
    expect(id1).toBe(id2);
  });

  it("different content produces different ID (collision resistance)", () => {
    const body1: EpisodicBody = {
      event: "tool_call",
      payload: { name: "grep" },
    };
    const body2: EpisodicBody = {
      event: "tool_call",
      payload: { name: "read" },
    };
    const id1 = computeRecordId("episodic", namespace, body1);
    const id2 = computeRecordId("episodic", namespace, body2);
    expect(id1).not.toBe(id2);
  });

  it("different namespace produces different ID (tenant isolation)", () => {
    const body: EpisodicBody = { event: "test", payload: {} };
    const ns2: Namespace = { org: "org-2", workspace: "ws-1" };
    const id1 = computeRecordId("episodic", namespace, body);
    const id2 = computeRecordId("episodic", ns2, body);
    expect(id1).not.toBe(id2);
  });

  it("different kind produces different ID", () => {
    const body: SemanticBody = { fact: "x is true", domain: "test" };
    const id1 = computeRecordId("episodic", namespace, body);
    const id2 = computeRecordId("semantic", namespace, body);
    expect(id1).not.toBe(id2);
  });
});

describe("createRecord", () => {
  it("produces a record with content-addressed ID", () => {
    const body: EpisodicBody = { event: "observation", payload: { data: 42 } };
    const record = createRecord({
      kind: "episodic",
      namespace,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });

    expect(record.id).toHaveLength(64);
    expect(record.kind).toBe("episodic");
    expect(record.namespace).toEqual(namespace);
    expect(record.body).toEqual(body);
    expect(record.salience).toBe(0.5);
    expect(record.confidence).toBe(1.0);
    expect(record.causality).toEqual([]);
    expect(record.createdAt).toBeGreaterThan(0);
  });

  it("sets causality from params when provided", () => {
    const body: EpisodicBody = { event: "decision", payload: {} };
    const record = createRecord({
      kind: "episodic",
      namespace,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
      causality: ["parent-id-1", "parent-id-2"],
    });

    expect(record.causality).toEqual(["parent-id-1", "parent-id-2"]);
  });

  it("sets ttl when provided", () => {
    const body: EpisodicBody = { event: "test", payload: {} };
    const ttl = Date.now() + 3600000; // 1 hour
    const record = createRecord({
      kind: "episodic",
      namespace,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
      ttl,
    });

    expect(record.ttl).toBe(ttl);
  });
});

describe("verifyRecordIntegrity", () => {
  it("returns true for a valid record", () => {
    const body: EpisodicBody = { event: "test", payload: { x: 1 } };
    const record = createRecord({
      kind: "episodic",
      namespace,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });

    expect(verifyRecordIntegrity(record)).toBe(true);
  });

  it("returns false if body is tampered", () => {
    const body: EpisodicBody = { event: "test", payload: { x: 1 } };
    const record = createRecord({
      kind: "episodic",
      namespace,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });

    // Tamper with the body
    const tampered = { ...record, body: { event: "test", payload: { x: 2 } } };
    expect(verifyRecordIntegrity(tampered)).toBe(false);
  });

  it("returns false if ID is manually changed", () => {
    const body: EpisodicBody = { event: "test", payload: {} };
    const record = createRecord({
      kind: "episodic",
      namespace,
      body,
      salience: 0.5,
      confidence: 1.0,
      provenance,
    });

    const tampered = { ...record, id: "a".repeat(64) };
    expect(verifyRecordIntegrity(tampered)).toBe(false);
  });
});
