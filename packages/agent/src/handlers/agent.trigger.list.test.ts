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

import { agentTriggerListHandler } from "./agent.trigger.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

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

describe("agent.trigger.list handler", () => {
  it("returns the agent's triggers mapped to the output shape", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [
        {
          id: "t-uuid",
          publicId: "atr_1",
          triggerType: "event",
          eventSource: "github_repo",
          eventType: "push",
          connectionId: null,
          filter: { branches: ["main"] },
          schedule: null,
          enabled: true,
        },
      ],
    );
    const out = await agentTriggerListHandler({ agentId: "agt_1" }, CTX);
    expect(out.triggers).toHaveLength(1);
    expect(out.triggers[0]!.triggerId).toBe("atr_1");
    expect(out.triggers[0]!.filter).toEqual({ branches: ["main"] });
  });

  it("normalizes a null filter to an empty object", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [
        {
          id: "t2",
          publicId: "atr_2",
          triggerType: "manual",
          eventSource: null,
          eventType: null,
          connectionId: null,
          filter: null,
          schedule: null,
          enabled: false,
        },
      ],
    );
    const out = await agentTriggerListHandler({ agentId: "agt_1" }, CTX);
    expect(out.triggers[0]!.filter).toEqual({});
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentTriggerListHandler({ agentId: "missing" }, CTX),
    ).rejects.toThrow(/not found/);
  });
});
