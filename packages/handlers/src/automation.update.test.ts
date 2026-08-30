import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schema } from "@oxagen/database";
import { automationUpdateHandler } from "./automation.update";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

type Trigger = {
  id: string;
  playbookId: string;
  triggerType: string;
  isEnabled: boolean;
} | null;
type Playbook = {
  name: string;
  description: string | null;
  status: string;
} | null;

const TRIGGER: Trigger = {
  id: "trg-uuid",
  playbookId: "plb-uuid",
  triggerType: "schedule",
  isEnabled: true,
};
const PLAYBOOK: Playbook = {
  name: "Nightly sync",
  description: "runs nightly",
  status: "active",
};

function setup(trigger: Trigger, playbook: Playbook) {
  const updatePlaybook = vi.fn((_t: unknown) => ({
    set: () => ({ where: () => Promise.resolve() }),
  }));
  const updateTrigger = vi.fn((_t: unknown) => ({
    set: () => ({ where: () => Promise.resolve() }),
  }));
  let call = 0;
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => {
      call++;
      if (call === 1) {
        return fn({
          query: {
            playbookTriggers: { findFirst: () => Promise.resolve(trigger) },
          },
        });
      }
      return fn({
        update: (table: unknown) =>
          table === schema.playbooks
            ? updatePlaybook(table)
            : updateTrigger(table),
        query: { playbooks: { findFirst: () => Promise.resolve(playbook) } },
      });
    },
  );
  return { updatePlaybook, updateTrigger };
}

describe("automation.update handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when there is no authenticated user", async () => {
    setup(TRIGGER, PLAYBOOK);
    const anon = makeCTX({ userId: null });
    await expect(
      automationUpdateHandler({ automation_id: "plt_1", name: "x" }, anon),
    ).rejects.toThrow("requires an authenticated user");
  });

  it("throws when the trigger is not found", async () => {
    setup(null, PLAYBOOK);
    await expect(
      automationUpdateHandler(
        { automation_id: "plt_missing", name: "x" },
        TEST_CTX,
      ),
    ).rejects.toThrow("trigger not found");
  });

  it("renames the playbook and returns the canonical fields", async () => {
    setup(TRIGGER, { ...PLAYBOOK!, name: "Renamed" });
    const out = await automationUpdateHandler(
      { automation_id: "plt_1", name: "Renamed" },
      TEST_CTX,
    );
    expect(out).toEqual({
      automation_id: "plt_1",
      name: "Renamed",
      description: "runs nightly",
      status: "active",
      triggerType: "schedule",
      enabled: true,
    });
  });

  it("updates the trigger config when provided", async () => {
    const { updateTrigger } = setup(TRIGGER, PLAYBOOK);
    await automationUpdateHandler(
      {
        automation_id: "plt_1",
        triggerConfig: { cronExpression: "0 9 * * 1" },
      },
      TEST_CTX,
    );
    expect(updateTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not touch the playbook when only the trigger config changes", async () => {
    const { updatePlaybook } = setup(TRIGGER, PLAYBOOK);
    await automationUpdateHandler(
      {
        automation_id: "plt_1",
        triggerConfig: { cronExpression: "0 0 * * *" },
      },
      TEST_CTX,
    );
    expect(updatePlaybook).not.toHaveBeenCalled();
  });
});
