import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DuckDBEpisodicStore } from "../store/duckdb-adapter";
import { BlackboardBus } from "./bus";
import { IntentLedger } from "./intent";
import { LeaseManager } from "./lease";
import { AgentCoordinator } from "./coordinator";
import { enforceAccess, defaultAgentPermissions, NamespaceAccessError, hasAccess } from "./access-control";
import { traceLineage } from "./lineage";
import { createRecord } from "../record";
import type { Namespace } from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const SESSION_NS: Namespace = { org: "test-org", workspace: "test-ws", session: "sess-1" };

describe("BlackboardBus", () => {
  let store: DuckDBEpisodicStore;
  let bus: BlackboardBus;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    bus = new BlackboardBus(store, { namespace: SESSION_NS, maxRetention: 1000 });
  });

  afterEach(async () => { await store.close(); });

  it("publishes a discovery and stores it", async () => {
    const id = await bus.publishDiscovery("agent-a", { event: "found_bug", payload: { file: "auth.ts" } });
    expect(id).toHaveLength(64);
    const records = await bus.getRecent(10);
    expect(records.length).toBeGreaterThan(0);
  });

  it("notifies subscribers on publish", async () => {
    const received: string[] = [];
    bus.registerAgent({ agentId: "agent-a", role: "finder", capabilities: [], registeredAt: Date.now() });
    bus.registerAgent({ agentId: "agent-b", role: "fixer", capabilities: [], registeredAt: Date.now() });

    bus.subscribe("agent-b", {}, async (ev) => { received.push(ev.recordId); });

    await bus.publishDiscovery("agent-a", { event: "discovery", payload: {} });
    expect(received).toHaveLength(1);
  });

  it("does not notify the publishing agent", async () => {
    const received: string[] = [];
    bus.subscribe("agent-a", {}, async (ev) => { received.push(ev.recordId); });
    await bus.publishDiscovery("agent-a", { event: "self", payload: {} });
    expect(received).toHaveLength(0);
  });

  it("filters by event type pattern", async () => {
    const received: string[] = [];
    bus.subscribe("agent-b", { eventTypes: ["assertion"] }, async (ev) => { received.push(ev.type); });

    await bus.publishDiscovery("agent-a", { event: "test", payload: {} });
    await bus.assertFact("agent-a", { fact: "X is true", domain: "test" }, 0.9);

    expect(received).toEqual(["assertion"]);
  });
});

describe("IntentLedger", () => {
  let ledger: IntentLedger;

  beforeEach(() => { ledger = new IntentLedger(); });

  it("first agent claims targets successfully", () => {
    const result = ledger.claim("agent-a", "fix", ["src/auth.ts"]);
    expect(result.success).toBe(true);
    expect(result.intentId).toBeDefined();
  });

  it("second agent on same targets gets conflict", () => {
    ledger.claim("agent-a", "fix", ["src/auth.ts"]);
    const result = ledger.claim("agent-b", "fix", ["src/auth.ts"]);
    expect(result.success).toBe(false);
    expect(result.conflictingIntent?.agentId).toBe("agent-a");
  });

  it("non-overlapping targets don't conflict", () => {
    ledger.claim("agent-a", "fix", ["src/auth.ts"]);
    const result = ledger.claim("agent-b", "fix", ["src/db.ts"]);
    expect(result.success).toBe(true);
  });

  it("expired intents free up targets", () => {
    ledger.claim("agent-a", "fix", ["src/auth.ts"], 1); // 1ms TTL
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const result = ledger.claim("agent-b", "fix", ["src/auth.ts"]);
    expect(result.success).toBe(true);
  });

  it("completed intents don't block new claims", () => {
    const claim = ledger.claim("agent-a", "fix", ["src/auth.ts"]);
    ledger.complete(claim.intentId!);
    const result = ledger.claim("agent-b", "fix", ["src/auth.ts"]);
    expect(result.success).toBe(true);
  });
});

describe("LeaseManager", () => {
  let leases: LeaseManager;

  beforeEach(() => { leases = new LeaseManager(); });

  it("grants a lease on an unclaimed resource", () => {
    const result = leases.acquire("agent-a", "git:worktree");
    expect(result.granted).toBe(true);
    expect(result.lease?.agentId).toBe("agent-a");
  });

  it("denies a lease when held by another agent", () => {
    leases.acquire("agent-a", "git:worktree");
    const result = leases.acquire("agent-b", "git:worktree");
    expect(result.granted).toBe(false);
    expect(result.heldBy).toBe("agent-a");
  });

  it("releases a lease so another agent can acquire", () => {
    leases.acquire("agent-a", "git:worktree");
    leases.release("git:worktree", "agent-a");
    const result = leases.acquire("agent-b", "git:worktree");
    expect(result.granted).toBe(true);
  });

  it("renews a renewable lease", () => {
    leases.acquire("agent-a", "deploy:prod", 1000, true);
    const renewed = leases.renew("deploy:prod", "agent-a", 5000);
    expect(renewed).toBe(true);
  });

  it("cannot renew a lease held by another agent", () => {
    leases.acquire("agent-a", "deploy:prod");
    const renewed = leases.renew("deploy:prod", "agent-b");
    expect(renewed).toBe(false);
  });
});

describe("AgentCoordinator", () => {
  let store: DuckDBEpisodicStore;
  let coordinator: AgentCoordinator;

  beforeEach(() => {
    store = new DuckDBEpisodicStore({ path: ":memory:" });
    const bus = new BlackboardBus(store, { namespace: SESSION_NS, maxRetention: 1000 });
    const intents = new IntentLedger();
    const leaseManager = new LeaseManager();
    coordinator = new AgentCoordinator(bus, intents, leaseManager);
  });

  afterEach(async () => { await store.close(); });

  it("beforeWork returns proceed when no conflict", () => {
    const result = coordinator.beforeWork("agent-a", "fix", ["src/main.ts"]);
    expect(result.decision).toBe("proceed");
    expect(result.intentId).toBeDefined();
  });

  it("beforeWork returns wait when another agent is working", () => {
    coordinator.beforeWork("agent-a", "fix", ["src/main.ts"]);
    const result = coordinator.beforeWork("agent-b", "fix", ["src/main.ts"]);
    expect(result.decision).toBe("wait");
    expect(result.conflictAgent).toBe("agent-a");
  });

  it("afterWork marks intent complete and publishes result", async () => {
    const claim = coordinator.beforeWork("agent-a", "fix", ["src/main.ts"]);
    await coordinator.afterWork("agent-a", claim.intentId!, { fixed: true });
    // The intent is now completed, so a new claim should succeed
    const newClaim = coordinator.beforeWork("agent-b", "fix", ["src/main.ts"]);
    expect(newClaim.decision).toBe("proceed");
  });
});

describe("Access Control", () => {
  const perms = defaultAgentPermissions("agent-a", "org-1", "ws-1", "sess-1");

  it("allows read on own private namespace", () => {
    expect(() => enforceAccess("agent-a", "read", { org: "org-1", workspace: "ws-1", session: "sess-1", agent: "agent-a" }, perms)).not.toThrow();
  });

  it("allows read on session shared namespace", () => {
    expect(() => enforceAccess("agent-a", "read", { org: "org-1", workspace: "ws-1", session: "sess-1" }, perms)).not.toThrow();
  });

  it("allows read on workspace namespace", () => {
    expect(() => enforceAccess("agent-a", "read", { org: "org-1", workspace: "ws-1" }, perms)).not.toThrow();
  });

  it("denies write to workspace namespace", () => {
    expect(() => enforceAccess("agent-a", "write", { org: "org-1", workspace: "ws-1" }, perms)).toThrow(NamespaceAccessError);
  });

  it("denies read to another org", () => {
    expect(() => enforceAccess("agent-a", "read", { org: "org-2", workspace: "ws-1" }, perms)).toThrow(NamespaceAccessError);
  });

  it("denies read to another agent's private namespace", () => {
    expect(() => enforceAccess("agent-a", "read", { org: "org-1", workspace: "ws-1", session: "sess-1", agent: "agent-b" }, perms)).toThrow(NamespaceAccessError);
  });

  it("hasAccess returns boolean without throwing", () => {
    expect(hasAccess("read", { org: "org-1", workspace: "ws-1" }, perms)).toBe(true);
    expect(hasAccess("write", { org: "org-2", workspace: "ws-1" }, perms)).toBe(false);
  });
});

describe("Lineage", () => {
  let store: DuckDBEpisodicStore;

  beforeEach(() => { store = new DuckDBEpisodicStore({ path: ":memory:" }); });
  afterEach(async () => { await store.close(); });

  it("traces a simple derivation chain", async () => {
    const source = createRecord({
      kind: "episodic", namespace: NS,
      body: { event: "observation", payload: { data: "raw" } },
      salience: 0.5, confidence: 1.0,
      provenance: { author: "agent-a", derivedFrom: [], timestamp: Date.now() },
    });
    await store.append(source);

    const derived = createRecord({
      kind: "semantic", namespace: NS,
      body: { fact: "Derived fact", domain: "test" },
      salience: 0.7, confidence: 0.8,
      provenance: { author: "consolidation", derivedFrom: [source.id], timestamp: Date.now() },
    });
    await store.append(derived);

    const chain = await traceLineage(derived.id, store);
    expect(chain).not.toBeNull();
    expect(chain!.target.recordId).toBe(derived.id);
    expect(chain!.ancestors).toHaveLength(1);
    expect(chain!.ancestors[0]!.recordId).toBe(source.id);
    expect(chain!.trustScore).toBeGreaterThan(0);
  });

  it("returns null for nonexistent record", async () => {
    const chain = await traceLineage("nonexistent", store);
    expect(chain).toBeNull();
  });
});
