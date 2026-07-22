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

import { agentDefinitionCreateHandler } from "./agent.definition.create";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const CONFIG = {
  graph: {
    ontologyId: "ont_1",
    mode: "read" as const,
    retrieval: { strategy: "hybrid" as const },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [{ type: "skill" as const, ref: "coding" }],
  triggers: [{ type: "manual" as const, enabled: true }],
  instructions: "hi",
};

const INPUT = {
  slug: "my-agent",
  name: "My Agent",
  agentType: "custom",
  config: CONFIG,
};

beforeEach(() => fake.reset());

describe("agent.definition.create handler", () => {
  it("inserts the agent row and v1 version, returning identity", async () => {
    fake.enqueue(
      [{ id: "prn-1" }], // principals insert returning
      [{ id: "role-contributor" }], // default role lookup (select)
      [], // principalRoleAssignments insert (awaited, no returning)
      [{ id: "uuid-1", publicId: "agt_1", slug: "my-agent" }], // agents insert returning
      [{ version: 1 }], // agent_versions insert returning
    );
    const out = await agentDefinitionCreateHandler(INPUT, CTX);
    expect(out.publicId).toBe("agt_1");
    expect(out.slug).toBe("my-agent");
    expect(out.version).toBe(1);
  });

  it("throws when no authenticated user", async () => {
    await expect(
      agentDefinitionCreateHandler(INPUT, makeCTX({ userId: null })),
    ).rejects.toThrow(/authenticated user/);
  });

  it("throws when the principals insert returns no row", async () => {
    fake.enqueue([]); // principals insert returns nothing
    await expect(agentDefinitionCreateHandler(INPUT, CTX)).rejects.toThrow(
      /principals insert failed/,
    );
  });

  it("throws when the agents insert returns no row", async () => {
    fake.enqueue([{ id: "prn-1" }], [{ id: "role-contributor" }], [], []); // principals ok, role lookup ok, PRA insert ok, agents insert returns nothing
    await expect(agentDefinitionCreateHandler(INPUT, CTX)).rejects.toThrow(
      /agents insert failed/,
    );
  });

  it("rejects a config that violates the schema", async () => {
    await expect(
      agentDefinitionCreateHandler(
        {
          ...INPUT,
          config: { ...CONFIG, graph: { ontologyId: "x" } } as never,
        },
        CTX,
      ),
    ).rejects.toThrow();
  });

  it("throws AgentManagedReadOnlyError when agentType is the reserved 'interactive_chat'", async () => {
    const err = await agentDefinitionCreateHandler(
      { ...INPUT, agentType: "interactive_chat" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe(
      "agent_managed_read_only",
    );
  });

  it("throws AgentManagedReadOnlyError when slug collides with the built-in 'qa-chat'", async () => {
    const err = await agentDefinitionCreateHandler(
      { ...INPUT, slug: "qa-chat" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe(
      "agent_managed_read_only",
    );
  });

  it("throws before any DB write when identity is reserved", async () => {
    const err = await agentDefinitionCreateHandler(
      { ...INPUT, agentType: "interactive_chat" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    // The guard short-circuits before any write — no insert was issued.
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });
});
