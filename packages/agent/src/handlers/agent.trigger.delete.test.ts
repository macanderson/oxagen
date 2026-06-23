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

import { agentTriggerDeleteHandler } from "./agent.trigger.delete";
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

describe("agent.trigger.delete handler", () => {
  it("soft-deletes the trigger and returns deleted=true", async () => {
    fake.enqueue(
      [TRIGGER_ROW], // resolveTrigger
      [], // update (awaited, no returning)
    );
    const out = await agentTriggerDeleteHandler({ triggerId: "atr_1" }, CTX);
    expect(out.triggerId).toBe("atr_1");
    expect(out.deleted).toBe(true);
  });

  it("throws AgentManagedReadOnlyError when the trigger belongs to a managed agent", async () => {
    fake.enqueue([MANAGED_TRIGGER_ROW]); // resolveTrigger → managed parent
    const err = await agentTriggerDeleteHandler({ triggerId: "atr_1" }, CTX).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentManagedReadOnlyError);
    expect((err as AgentManagedReadOnlyError).code).toBe("agent_managed_read_only");
    // The guard fires before any write — no insert/update/delete was issued.
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
  });

  it("throws when the trigger is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentTriggerDeleteHandler({ triggerId: "missing" }, CTX),
    ).rejects.toThrow(/not found/);
  });

  it("throws without an authenticated user", async () => {
    await expect(
      agentTriggerDeleteHandler({ triggerId: "atr_1" }, makeCTX({ userId: null })),
    ).rejects.toThrow(/authenticated user/);
  });
});
