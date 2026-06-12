import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  triggerFindFirst: vi.fn(),
  playbookFindFirst: vi.fn(),
  insertReturning: vi.fn(),
}));

// withTenantDb is called three times:
//   call 1 → query.playbookTriggers.findFirst (resolve trigger)
//   call 2 → query.playbooks.findFirst (resolve playbook active version)
//   call 3 → insert into playbookRuns (create run)
let withTenantDbCallCount = 0;

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      withTenantDbCallCount++;
      const call = withTenantDbCallCount;
      if (call === 1) {
        return fn({
          query: {
            playbookTriggers: { findFirst: mocks.triggerFindFirst },
          },
        });
      }
      if (call === 2) {
        return fn({
          query: {
            playbooks: { findFirst: mocks.playbookFindFirst },
          },
        });
      }
      // call 3 → insert path
      return fn({
        insert: (_table: unknown) => ({
          values: (_vals: unknown) => ({
            returning: mocks.insertReturning,
          }),
        }),
      });
    },
  };
});

import { automationTriggerHandler } from "./automation.trigger";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const MOCK_TRIGGER = {
  id: "plt-uuid-1",
  publicId: "plt_abc",
  playbookId: "plb-uuid-1",
  pinnedVersionId: null as string | null,
};

const MOCK_PLAYBOOK = {
  id: "plb-uuid-1",
  activeVersionId: "ver-uuid-1",
};

const MOCK_RUN = { id: "run-uuid-1", status: "pending" };

const BASE_INPUT = {
  automation_id: "plt_abc",
  payload: undefined as Record<string, unknown> | undefined,
};

function setupHappyPath() {
  mocks.triggerFindFirst.mockResolvedValue(MOCK_TRIGGER);
  mocks.playbookFindFirst.mockResolvedValue(MOCK_PLAYBOOK);
  mocks.insertReturning.mockResolvedValue([MOCK_RUN]);
}

describe("automationTriggerHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTenantDbCallCount = 0;
    setupHappyPath();
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(automationTriggerHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "automation.trigger requires an authenticated user",
    );
  });

  // ── not-found guard ───────────────────────────────────────────────────────

  it("throws when the trigger is not found in this tenant", async () => {
    mocks.triggerFindFirst.mockResolvedValueOnce(undefined);
    await expect(automationTriggerHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.trigger: trigger not found: plt_abc",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns execution_id and status on successful trigger", async () => {
    const result = await automationTriggerHandler(BASE_INPUT, CTX);
    expect(result.execution_id).toBe(MOCK_RUN.id);
    expect(result.status).toBe("pending");
  });

  it("calls findFirst to resolve the trigger and playbook before inserting the run", async () => {
    await automationTriggerHandler(BASE_INPUT, CTX);
    expect(mocks.triggerFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.playbookFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
  });

  it("throws when the run insert returns no row", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    await expect(automationTriggerHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.trigger: run insert returned no row",
    );
  });

  it("accepts an optional payload", async () => {
    const result = await automationTriggerHandler(
      { automation_id: "plt_abc", payload: { key: "value" } },
      CTX,
    );
    expect(result.execution_id).toBe(MOCK_RUN.id);
  });
});
