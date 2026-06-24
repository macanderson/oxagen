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

import { agentTriggerCreateHandler } from "./agent.trigger.create";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "my-agent",
  name: "My Agent",
  description: null,
  agentType: "custom",
  status: "active",
  deploymentStatus: "active",
  activeVersionId: "ver-1",
};

const MANAGED_AGENT_ROW = {
  ...AGENT_ROW,
  publicId: "agt_builtin",
  slug: "qa-chat",
  agentType: "interactive_chat",
};

beforeEach(() => fake.reset());

describe("agent.trigger.create handler", () => {
  it("creates a manual trigger and returns identity", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [{ id: "t-uuid", publicId: "atr_1", triggerType: "manual", enabled: true }],
    );
    const out = await agentTriggerCreateHandler(
      { agentId: "agt_1", trigger: { type: "manual", enabled: true } },
      CTX,
    );
    expect(out.triggerId).toBe("atr_1");
    expect(out.triggerType).toBe("manual");
  });

  it("validates the trigger shape (rejects event w/o source)", async () => {
    fake.enqueue([AGENT_ROW]);
    await expect(
      agentTriggerCreateHandler(
        { agentId: "agt_1", trigger: { type: "event", enabled: true } as never },
        CTX,
      ),
    ).rejects.toThrow();
  });

  it("throws AgentManagedReadOnlyError for a managed agent and performs no insert", async () => {
    fake.enqueue([MANAGED_AGENT_ROW]); // resolveAgent → managed
    const err = await agentTriggerCreateHandler(
      { agentId: "agt_builtin", trigger: { type: "manual", enabled: true } },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe("agent_managed_read_only");
    // The guard fires before any write — no insert/update/delete was issued.
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentTriggerCreateHandler(
        { agentId: "missing", trigger: { type: "manual", enabled: true } },
        CTX,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentTriggerCreateHandler(
        { agentId: "agt_1", trigger: { type: "manual", enabled: true } },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });
});
