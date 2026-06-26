/**
 * Integration tests for the createEngram facade — exercises the full public
 * API through a real DuckDB store. These are the highest-value tests because
 * they validate the entire write path end-to-end in a single process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEngram, createStore, type Engram, type EpisodicStore } from "./index";

const NS = { org: "test-org", workspace: "test-ws" };
const PROV = { author: "test-agent", derivedFrom: [], timestamp: Date.now() };
const OPTS = { namespace: NS, provenance: PROV };

describe("createEngram facade", () => {
  let store: EpisodicStore;
  let engram: Engram;

  beforeEach(() => {
    store = createStore({ adapter: "duckdb", duckdbPath: ":memory:" });
    engram = createEngram(store);
  });

  afterEach(async () => {
    await engram.close();
  });

  describe("remember()", () => {
    it("writes an episodic record and returns a content-addressed ID", async () => {
      const id = await engram.remember(
        { event: "tool_call", payload: { tool: "grep", query: "foo" }, outcome: "success" },
        OPTS,
      );
      expect(id).toHaveLength(64);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is idempotent — same content produces same ID", async () => {
      const event = { event: "observation", payload: { x: 1 } };
      const id1 = await engram.remember(event, OPTS);
      const id2 = await engram.remember(event, OPTS);
      expect(id1).toBe(id2);
    });

    it("different events produce different IDs", async () => {
      const id1 = await engram.remember({ event: "a", payload: {} }, OPTS);
      const id2 = await engram.remember({ event: "b", payload: {} }, OPTS);
      expect(id1).not.toBe(id2);
    });
  });

  describe("assert()", () => {
    it("writes a semantic fact with confidence", async () => {
      const id = await engram.assert(
        { fact: "The API uses REST", domain: "architecture" },
        0.95,
        OPTS,
      );
      expect(id).toHaveLength(64);

      const record = await store.getById(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe("semantic");
      expect(record!.confidence).toBe(0.95);
    });

    it("clamps confidence to [0, 1]", async () => {
      const id = await engram.assert(
        { fact: "over-confident fact", domain: "test" },
        5.0,
        OPTS,
      );
      const record = await store.getById(id);
      expect(record!.confidence).toBe(1.0);
    });
  });

  describe("relate()", () => {
    it("writes an edge between two entities", async () => {
      const id = await engram.relate("src-id", "DEPENDS_ON", "tgt-id", OPTS, { weight: 0.8 });
      expect(id).toHaveLength(64);

      const record = await store.getById(id);
      expect(record!.kind).toBe("edge");
      expect(record!.body).toEqual({
        sourceId: "src-id",
        targetId: "tgt-id",
        edgeType: "DEPENDS_ON",
        properties: { weight: 0.8 },
      });
    });
  });

  describe("pin() / unpin()", () => {
    it("pins a procedural rule with salience 1.0", async () => {
      const id = await engram.pin(
        { rule: "Always validate input", appliesTo: ["api"], successCount: 0, failureCount: 0 },
        OPTS,
      );
      const record = await store.getById(id);
      expect(record!.kind).toBe("procedural");
      expect(record!.salience).toBe(1.0);
    });

    it("unpin writes an episodic unpin event referencing the rule", async () => {
      const ruleId = await engram.pin(
        { rule: "test rule", appliesTo: ["test"], successCount: 0, failureCount: 0 },
        OPTS,
      );
      await engram.unpin(ruleId, OPTS);

      const all = await store.query({ namespace: NS, limit: 100 });
      const unpinEvent = all.find(
        (r) => r.kind === "episodic" && (r.body as { event?: string }).event === "rule_unpinned",
      );
      expect(unpinEvent).toBeDefined();
      expect(unpinEvent!.causality).toContain(ruleId);
    });
  });

  describe("cross-namespace isolation", () => {
    it("records from one workspace are invisible to another", async () => {
      await engram.remember(
        { event: "ws1-only", payload: {} },
        { namespace: { org: "org-1", workspace: "ws-1" }, provenance: PROV },
      );
      await engram.remember(
        { event: "ws2-only", payload: {} },
        { namespace: { org: "org-1", workspace: "ws-2" }, provenance: PROV },
      );

      const ws1Records = await store.query({ namespace: { org: "org-1", workspace: "ws-1" }, limit: 100 });
      const ws2Records = await store.query({ namespace: { org: "org-1", workspace: "ws-2" }, limit: 100 });

      expect(ws1Records).toHaveLength(1);
      expect(ws2Records).toHaveLength(1);
      expect(ws1Records[0]!.id).not.toBe(ws2Records[0]!.id);
    });
  });

  describe("nodeRef and entityRefs pass-through", () => {
    it("includes nodeRef and entityRefs in WriteOpts without error", async () => {
      const id = await engram.remember(
        { event: "tool_call", payload: { tool: "read" } },
        { ...OPTS, nodeRef: "file:src/main.ts", entityRefs: ["kn-abc", "kn-def"] },
      );
      // The record itself doesn't store nodeRef/entityRefs on the body — they're
      // for the graph sync layer. But the write should succeed without error.
      expect(id).toHaveLength(64);
    });
  });
});
