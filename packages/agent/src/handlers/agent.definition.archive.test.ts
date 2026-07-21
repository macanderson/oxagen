import { describe, expect, it, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

import { vi } from "vitest";
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentDefinitionArchiveHandler } from "./agent.definition.archive";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "rbac-agent",
  name: "RBAC Agent",
  description: null,
  agentType: "custom",
  status: "active",
  deploymentStatus: "active",
  activeVersionId: "ver-1",
  avatarUrl: null,
  summary: null,
  summaryChecksum: null,
  principalId: "prn-1",
};

beforeEach(() => fake.reset());

describe("agent.definition.archive handler", () => {
  it("soft-deletes the agent and soft-deletes its IAM principal together", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent select
      [], // agents update
      [], // principals update
    );

    const out = await agentDefinitionArchiveHandler({ agentId: "agt_1" }, CTX);

    expect(out).toEqual({ agentId: "agt_1", archived: true });
    // Two mutating updates were issued: the agent row and the principal row.
    expect(fake.mutations.update).toBe(2);
  });

  it("skips the principal update when the agent carries no principalId", async () => {
    fake.enqueue([{ ...AGENT_ROW, principalId: null }], []);

    await agentDefinitionArchiveHandler({ agentId: "agt_1" }, CTX);

    expect(fake.mutations.update).toBe(1);
  });

  it("throws when no authenticated user", async () => {
    await expect(
      agentDefinitionArchiveHandler(
        { agentId: "agt_1" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]); // resolveAgent select returns nothing
    await expect(
      agentDefinitionArchiveHandler({ agentId: "agt_missing" }, CTX),
    ).rejects.toThrow(/not found/);
  });

  it("throws AgentManagedReadOnlyError for a managed agent", async () => {
    fake.enqueue([{ ...AGENT_ROW, agentType: "interactive_chat" }]);
    const err = await agentDefinitionArchiveHandler(
      { agentId: "agt_1" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
  });
});
