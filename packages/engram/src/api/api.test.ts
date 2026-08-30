import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { remember } from "./remember";
import { assert } from "./assert";
import { relate } from "./relate";
import { pin, unpin, resolveActivePins } from "./pin";
import { createRecord } from "../record";
import type { EntityBody, Namespace, Provenance, WriteOpts } from "../types";

/** Store an entity record and return its id, for edge-endpoint fixtures. */
async function seedEntity(
  store: DuckDBEpisodicStore,
  name: string,
): Promise<string> {
  const body: EntityBody = { entityType: "file", name, properties: {} };
  const record = createRecord({
    kind: "entity",
    namespace,
    body,
    salience: 0.5,
    confidence: 1.0,
    provenance,
  });
  await store.append(record);
  return record.id;
}

const namespace: Namespace = { org: "test-org", workspace: "test-ws" };
const provenance: Provenance = {
  author: "test-agent",
  derivedFrom: [],
  timestamp: Date.now(),
};
const opts: WriteOpts = { namespace, provenance };

describe("Write API", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
  });

  afterEach(async () => {
    await store.close();
  });

  describe("remember()", () => {
    it("writes an episodic event and returns its ID", async () => {
      const id = await remember(
        store,
        { event: "tool_call", payload: { name: "search" }, outcome: "success" },
        opts,
      );
      expect(id).toHaveLength(64);

      const record = await store.getById(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe("episodic");
      expect(record!.body).toEqual({
        event: "tool_call",
        payload: { name: "search" },
        outcome: "success",
      });
    });

    it("uses heuristic salience when not explicitly set", async () => {
      const id = await remember(
        store,
        { event: "error", payload: {}, outcome: "failure" },
        opts,
      );
      const record = await store.getById(id);
      // error + failure = baseline(0.3) + failure(0.2) + error(0.15) = 0.65
      expect(record!.salience).toBeCloseTo(0.65);
    });

    it("uses explicit salience when provided", async () => {
      const id = await remember(
        store,
        { event: "test", payload: {} },
        { ...opts, salience: 0.99 },
      );
      const record = await store.getById(id);
      expect(record!.salience).toBe(0.99);
    });
  });

  describe("assert()", () => {
    it("writes a semantic fact with confidence", async () => {
      const id = await assert(
        store,
        { fact: "The API uses OAuth2", domain: "auth" },
        0.95,
        opts,
      );
      expect(id).toHaveLength(64);

      const record = await store.getById(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe("semantic");
      expect(record!.confidence).toBe(0.95);
    });

    it("clamps confidence to [0, 1]", async () => {
      const id = await assert(
        store,
        { fact: "Overclamped", domain: "test" },
        1.5,
        opts,
      );
      const record = await store.getById(id);
      expect(record!.confidence).toBe(1.0);
    });
  });

  describe("relate()", () => {
    it("writes an edge record between existing endpoints", async () => {
      const sourceId = await seedEntity(store, "caller.ts");
      const targetId = await seedEntity(store, "callee.ts");

      const id = await relate(store, sourceId, "CALLS", targetId, opts, {
        weight: 1.0,
      });
      expect(id).toHaveLength(64);

      const record = await store.getById(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe("edge");
      expect(record!.body).toEqual({
        sourceId,
        targetId,
        edgeType: "CALLS",
        properties: { weight: 1.0 },
      });
    });

    it("rejects a dangling edge whose source does not exist", async () => {
      const targetId = await seedEntity(store, "callee.ts");
      await expect(
        relate(store, "missing-source", "CALLS", targetId, opts),
      ).rejects.toThrow(/source node/);
    });

    it("rejects a dangling edge whose target does not exist", async () => {
      const sourceId = await seedEntity(store, "caller.ts");
      await expect(
        relate(store, sourceId, "CALLS", "missing-target", opts),
      ).rejects.toThrow(/target node/);
    });
  });

  describe("pin()", () => {
    it("writes a procedural rule with maximum salience", async () => {
      const id = await pin(
        store,
        {
          rule: "Always run tests before commit",
          appliesTo: ["git"],
          successCount: 0,
          failureCount: 0,
        },
        opts,
      );
      expect(id).toHaveLength(64);

      const record = await store.getById(id);
      expect(record).not.toBeNull();
      expect(record!.kind).toBe("procedural");
      expect(record!.salience).toBe(1.0);
    });
  });

  describe("unpin()", () => {
    it("writes an unpin event referencing the rule ID", async () => {
      const ruleId = await pin(
        store,
        {
          rule: "Test rule",
          appliesTo: ["test"],
          successCount: 0,
          failureCount: 0,
        },
        opts,
      );

      await unpin(store, ruleId, opts);

      // Should find the unpin event
      const results = await store.query({ namespace, limit: 100 });
      const unpinEvent = results.find(
        (r) =>
          r.kind === "episodic" &&
          (r.body as { event: string }).event === "rule_unpinned",
      );
      expect(unpinEvent).toBeDefined();
      expect(unpinEvent!.causality).toContain(ruleId);
    });
  });

  describe("pin/unpin resolution (M-3)", () => {
    const rule = {
      rule: "Prefer withTenantDb over raw db()",
      appliesTo: ["db"],
      successCount: 0,
      failureCount: 0,
    };

    async function activeRuleIds(): Promise<string[]> {
      const pinned = await store.query({
        namespace,
        kinds: ["procedural"],
        minSalience: 1.0,
        limit: 50,
      });
      const markers = await store.query({
        namespace,
        kinds: ["episodic"],
        limit: 500,
      });
      return resolveActivePins(pinned, markers).map((r) => r.id);
    }

    it("pin → unpin → pin re-activates the rule (latest marker wins)", async () => {
      const ruleId = await pin(store, rule, opts);
      expect(await activeRuleIds()).toContain(ruleId);

      await unpin(store, ruleId, opts);
      expect(await activeRuleIds()).not.toContain(ruleId);

      const rePinnedId = await pin(store, rule, opts);
      expect(rePinnedId).toBe(ruleId); // same content-addressed record
      expect(await activeRuleIds()).toContain(ruleId);
    });

    it("a rule with no markers stays active (backward compatible)", async () => {
      const orphan = createRecord({
        kind: "procedural",
        namespace,
        body: rule,
        salience: 1.0,
        confidence: 1.0,
        provenance,
      });
      await store.append(orphan);
      expect(await activeRuleIds()).toContain(orphan.id);
    });
  });
});
