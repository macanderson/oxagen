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

import { agentDefinitionDeleteHandler } from "./agent.definition.delete";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "agt-uuid",
  publicId: "agt_1",
  slug: "my-agent",
  name: "My Agent",
  description: null,
  agentType: "custom",
  status: "active" as const,
  deploymentStatus: "inactive" as const,
  activeVersionId: null,
  avatarUrl: null,
  summary: null,
  summaryChecksum: null,
};

const MANAGED_AGENT_ROW = { ...AGENT_ROW, agentType: "interactive_chat" };

beforeEach(() => fake.reset());

describe("agent.definition.delete handler", () => {
  it("soft-deletes the agent and its delegated principal together", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [], // update agents.deletedAt (awaited, no returning)
      [{ principalId: "prn-uuid" }], // select agents.principalId
      [], // update principals.status='deleted'
    );

    const out = await agentDefinitionDeleteHandler({ agentId: "agt_1" }, CTX);

    expect(out).toEqual({ agentId: "agt_1", deleted: true });
    // Two updates: the agent soft-delete, then the principal soft-delete.
    expect(fake.mutations.update).toBe(2);
  });

  it("skips the principal update when the agent carries no principalId", async () => {
    fake.enqueue([AGENT_ROW], [], [{ principalId: null }]);

    const out = await agentDefinitionDeleteHandler({ agentId: "agt_1" }, CTX);

    expect(out.deleted).toBe(true);
    // Only the agent soft-delete update fires; no principal update.
    expect(fake.mutations.update).toBe(1);
  });

  it("throws AgentManagedReadOnlyError for a managed agent and issues no writes", async () => {
    fake.enqueue([MANAGED_AGENT_ROW]);
    const err = await agentDefinitionDeleteHandler(
      { agentId: "agt_1" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentDefinitionDeleteHandler({ agentId: "missing" }, CTX),
    ).rejects.toThrow(/not found/);
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentDefinitionDeleteHandler(
        { agentId: "agt_1" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });
});
