import { describe, expect, it, vi, beforeEach } from "vitest";

// Silence the logger to keep test output clean.
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { bootstrapWorkspaceAgents } from "./workspace-agents";

// ── Fluent, queue-driven fake Drizzle tx ──────────────────────────────────────
// Every builder method returns the same chain; the chain resolves to the next
// queued result only when awaited. Mirrors the per-query terminate pattern the
// bootstrap uses (each select/insert/update is awaited before the next).

function createFakeTx() {
  const queue: unknown[] = [];
  function makeChain(): unknown {
    let consumed = false;
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop) {
        if (prop === "then") {
          return (onFulfilled: (v: unknown) => unknown) => {
            const value = consumed ? [] : queue.length ? queue.shift() : [];
            consumed = true;
            return Promise.resolve(value).then(onFulfilled);
          };
        }
        return () => proxy;
      },
    };
    const proxy: unknown = new Proxy({}, handler);
    return proxy;
  }
  return {
    tx: {
      select: () => makeChain(),
      insert: () => makeChain(),
      update: () => makeChain(),
    },
    enqueue: (...r: unknown[]) => queue.push(...r),
  };
}

const ARGS = {
  workspaceId: "018f1a2b-3c4d-7e6f-8a9b-0c1d2e3f4a5b",
  orgId: "org_1",
  userId: "user_1",
};

describe("bootstrapWorkspaceAgents", () => {
  let fake: ReturnType<typeof createFakeTx>;
  beforeEach(() => {
    fake = createFakeTx();
  });

  it("creates a fresh qa-chat agent, published v1, wired active", async () => {
    fake.enqueue(
      [], // select existing agent → none
      [{ id: "agt-uuid" }], // insert agent returning
      [], // select existing version → none
      [{ id: "ver-uuid" }], // insert version returning
      [], // update agent (wire active)
    );
    await expect(
      bootstrapWorkspaceAgents({ ...ARGS, tx: fake.tx as never }),
    ).resolves.toBeUndefined();
  });

  it("skips when an agent already has an active version", async () => {
    fake.enqueue([{ id: "agt-uuid", activeVersionId: "ver-uuid" }]);
    await expect(
      bootstrapWorkspaceAgents({ ...ARGS, tx: fake.tx as never }),
    ).resolves.toBeUndefined();
  });

  it("reconciles a legacy agent that lacks an active version", async () => {
    fake.enqueue(
      [{ id: "agt-uuid", activeVersionId: null }], // existing, unpublished
      [{ id: "ver-uuid", isPublished: false }], // existing v1 to reconcile
      [], // update version
      [], // update agent
    );
    await expect(
      bootstrapWorkspaceAgents({ ...ARGS, tx: fake.tx as never }),
    ).resolves.toBeUndefined();
  });

  it("recovers from a concurrent agent-insert race via re-select", async () => {
    fake.enqueue(
      [], // select existing → none
      [], // insert agent returning → empty (race)
      [{ id: "agt-uuid" }], // re-select agent
      [], // select existing version → none
      [{ id: "ver-uuid" }], // insert version returning
      [], // update agent
    );
    await expect(
      bootstrapWorkspaceAgents({ ...ARGS, tx: fake.tx as never }),
    ).resolves.toBeUndefined();
  });

  it("throws when the agent cannot be upserted after a lost race", async () => {
    fake.enqueue(
      [], // select existing → none
      [], // insert returning → empty
      [], // re-select → still empty
    );
    await expect(
      bootstrapWorkspaceAgents({ ...ARGS, tx: fake.tx as never }),
    ).rejects.toThrow(/Failed to upsert qa-chat agent/);
  });
});
