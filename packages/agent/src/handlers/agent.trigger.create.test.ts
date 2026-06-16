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
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "uuid-1",
  publicId: "agt_1",
  slug: "qa-chat",
  name: "QA",
  description: null,
  agentType: "interactive_chat",
  status: "active",
  deploymentStatus: "active",
  activeVersionId: "ver-1",
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
