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

import { agentTriggerUpdateHandler } from "./agent.trigger.update";
import { AgentManagedReadOnlyError } from "./_agent-definition";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const TRIGGER_ROW = {
  id: "t-uuid",
  publicId: "atr_1",
  agentId: "uuid-1",
  agentType: "custom",
};

const MANAGED_TRIGGER_ROW = {
  ...TRIGGER_ROW,
  agentType: "interactive_chat",
};

beforeEach(() => fake.reset());

describe("agent.trigger.update handler", () => {
  it("updates a trigger in place and returns its new state", async () => {
    fake.enqueue(
      [TRIGGER_ROW], // resolveTrigger
      [{ publicId: "atr_1", triggerType: "schedule", enabled: false }], // update returning
    );
    const out = await agentTriggerUpdateHandler(
      {
        triggerId: "atr_1",
        trigger: { type: "schedule", schedule: "0 9 * * *", enabled: false },
      },
      CTX,
    );
    expect(out.triggerType).toBe("schedule");
    expect(out.enabled).toBe(false);
  });

  it("throws AgentManagedReadOnlyError when the trigger belongs to a managed agent", async () => {
    fake.enqueue([MANAGED_TRIGGER_ROW]); // resolveTrigger → managed parent
    const err = await agentTriggerUpdateHandler(
      {
        triggerId: "atr_1",
        trigger: { type: "manual", enabled: false },
      },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe("agent_managed_read_only");
  });

  it("throws when the trigger is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentTriggerUpdateHandler(
        { triggerId: "missing", trigger: { type: "manual", enabled: true } },
        CTX,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("validates the trigger shape", async () => {
    fake.enqueue([TRIGGER_ROW]);
    await expect(
      agentTriggerUpdateHandler(
        {
          triggerId: "atr_1",
          trigger: { type: "schedule", enabled: true } as never,
        },
        CTX,
      ),
    ).rejects.toThrow();
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentTriggerUpdateHandler(
        { triggerId: "atr_1", trigger: { type: "manual", enabled: true } },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });
});
