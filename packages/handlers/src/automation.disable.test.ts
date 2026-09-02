import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  triggerFindFirst: vi.fn(),
  updateSetTrigger: vi.fn(),
  updateSetPlaybook: vi.fn(),
}));

// withTenantDb is called twice:
//   call 1 → query.playbookTriggers.findFirst (resolve trigger)
//   call 2 → update trigger + update playbook (disable transaction)
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
      // call 2 → update transaction: trigger first, playbook second
      let updateCallCount = 0;
      return fn({
        update: (_table: unknown) => ({
          set: (_vals: unknown) => ({
            where: () => {
              updateCallCount++;
              return updateCallCount === 1
                ? mocks.updateSetTrigger()
                : mocks.updateSetPlaybook();
            },
          }),
        }),
      });
    },
  };
});

import { automationDisableHandler } from "./automation.disable";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const MOCK_TRIGGER = {
  id: "plt-uuid-1",
  publicId: "plt_abc",
  playbookId: "plb-uuid-1",
};

const BASE_INPUT = { automation_id: "plt_abc" };

function setupHappyPath() {
  mocks.triggerFindFirst.mockResolvedValue(MOCK_TRIGGER);
  mocks.updateSetTrigger.mockResolvedValue([]);
  mocks.updateSetPlaybook.mockResolvedValue([]);
}

describe("automationDisableHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTenantDbCallCount = 0;
    setupHappyPath();
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(automationDisableHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "automation.disable requires an authenticated user",
    );
  });

  // ── not-found guard ───────────────────────────────────────────────────────

  it("throws when trigger is not found in this tenant", async () => {
    mocks.triggerFindFirst.mockResolvedValueOnce(undefined);
    await expect(automationDisableHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.disable: trigger not found: plt_abc",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns automation_id, enabled=false, status=paused on success", async () => {
    const result = await automationDisableHandler(BASE_INPUT, CTX);
    expect(result.automation_id).toBe("plt_abc");
    expect(result.enabled).toBe(false);
    expect(result.status).toBe("paused");
  });

  it("calls findFirst to resolve the trigger then performs the update", async () => {
    await automationDisableHandler(BASE_INPUT, CTX);
    expect(mocks.triggerFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.updateSetTrigger).toHaveBeenCalledTimes(1);
    expect(mocks.updateSetPlaybook).toHaveBeenCalledTimes(1);
  });

  it("passes different automation_id through to the error message", async () => {
    mocks.triggerFindFirst.mockResolvedValueOnce(undefined);
    await expect(
      automationDisableHandler({ automation_id: "plt_xyz" }, CTX),
    ).rejects.toThrow("automation.disable: trigger not found: plt_xyz");
  });

  it("works with mcp surface (AI agents may call disable without approval)", async () => {
    const mcpCtx = makeCTX({ surface: "mcp" });
    const result = await automationDisableHandler(BASE_INPUT, mcpCtx);
    expect(result.enabled).toBe(false);
  });

  it("works with api surface", async () => {
    const result = await automationDisableHandler(BASE_INPUT, CTX);
    expect(result.enabled).toBe(false);
  });
});
