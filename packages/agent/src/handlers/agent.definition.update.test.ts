import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentDefinitionUpdateHandler } from "./agent.definition.update";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const CONFIG = {
  graph: {
    ontologyId: "ont_1",
    mode: "read" as const,
    retrieval: { strategy: "semantic" as const },
    budget: { maxHops: 1, maxNodes: 10 },
  },
  agentTools: [],
  triggers: [],
};

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "my-agent",
  name: "My Agent",
  description: null,
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  activeVersionId: null,
};

const MANAGED_AGENT_ROW = {
  ...AGENT_ROW,
  publicId: "agt_builtin",
  slug: "qa-chat",
  agentType: "interactive_chat",
};

beforeEach(() => fake.reset());

describe("agent.definition.update handler", () => {
  it("snapshots a new unpublished version with a bumped number", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [{ version: 2 }], // latest version query
      [{ version: 3, isPublished: false }], // insert returning
    );
    const out = await agentDefinitionUpdateHandler(
      { agentId: "agt_1", config: CONFIG },
      CTX,
    );
    expect(out.agentId).toBe("agt_1");
    expect(out.version).toBe(3);
    expect(out.isPublished).toBe(false);
  });

  it("starts at version 1 when no prior versions exist", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [], // no latest version
      [{ version: 1, isPublished: false }],
    );
    const out = await agentDefinitionUpdateHandler(
      { agentId: "agt_1", config: CONFIG },
      CTX,
    );
    expect(out.version).toBe(1);
  });

  it("updates name/description when supplied", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ version: 1 }],
      [{ version: 2, isPublished: false }],
      [], // update agents (awaited, no returning)
    );
    const out = await agentDefinitionUpdateHandler(
      { agentId: "agt_1", name: "New", description: "d", config: CONFIG },
      CTX,
    );
    expect(out.version).toBe(2);
  });

  it("persists a custom→coding agentType change on the identity row", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ version: 1 }],
      [{ version: 2, isPublished: false }],
      [], // update agents (awaited, no returning)
    );
    const out = await agentDefinitionUpdateHandler(
      { agentId: "agt_1", agentType: "coding", config: CONFIG },
      CTX,
    );
    expect(out.version).toBe(2);
    // The identity-row update fired (name/description absent, agentType present).
    expect(fake.mutations.update).toBe(1);
  });

  it("rejects promoting an agent into a reserved managed agentType before any write", async () => {
    fake.enqueue([AGENT_ROW]); // resolveAgent only — guard fires before the insert
    await expect(
      agentDefinitionUpdateHandler(
        { agentId: "agt_1", agentType: "interactive_chat", config: CONFIG },
        CTX,
      ),
    ).rejects.toThrow(/reserved for managed agents/);
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("throws AgentManagedReadOnlyError for a managed agent and performs no mutation", async () => {
    fake.enqueue([MANAGED_AGENT_ROW]); // resolveAgent → managed agent
    const err = await agentDefinitionUpdateHandler(
      { agentId: "agt_builtin", config: CONFIG },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe(
      "agent_managed_read_only",
    );
    // The guard fires before any write — no insert/update/delete was issued.
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]); // resolveAgent → none
    await expect(
      agentDefinitionUpdateHandler({ agentId: "missing", config: CONFIG }, CTX),
    ).rejects.toThrow(/not found/);
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentDefinitionUpdateHandler(
        { agentId: "agt_1", config: CONFIG },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });
});
