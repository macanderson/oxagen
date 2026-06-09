import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  insertReturning: vi.fn(),
}));

mocks.findFirst.mockResolvedValue({ id: "uuid-aut-1", publicId: "aut_abc" });
mocks.insertReturning.mockResolvedValue([{ publicId: "aur_exec1", status: "running" }]);

// withTenantDb is called twice:
//   call 1 → query.automations.findFirst (resolve automation)
//   call 2 → insert into automationRuns (create run)
// We track how many times it's been called and route accordingly.
let withTenantDbCallCount = 0;

vi.mock("@oxagen/database", () => ({
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    withTenantDbCallCount++;
    if (withTenantDbCallCount % 2 === 1) {
      // Odd calls → findFirst path
      return fn({
        query: {
          automations: { findFirst: mocks.findFirst },
        },
      });
    }
    // Even calls → insert path
    return fn({
      insert: (_table: unknown) => ({
        values: (_vals: unknown) => ({
          returning: mocks.insertReturning,
        }),
      }),
    });
  },
  schema: {
    automations: {
      publicId: "publicId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      deletedAt: "deletedAt",
      id: "id",
    },
    automationRuns: {
      publicId: "publicId",
      status: "status",
      orgId: "orgId",
      workspaceId: "workspaceId",
      automationId: "automationId",
      payload: "payload",
      startedAt: "startedAt",
      createdByUserId: "createdByUserId",
      updatedByUserId: "updatedByUserId",
    },
  },
}));

import { automationTriggerHandler } from "./automation.trigger";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const BASE_INPUT = {
  automation_id: "aut_abc",
  payload: undefined as Record<string, unknown> | undefined,
};

describe("automationTriggerHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTenantDbCallCount = 0;
    mocks.findFirst.mockResolvedValue({ id: "uuid-aut-1", publicId: "aut_abc" });
    mocks.insertReturning.mockResolvedValue([{ publicId: "aur_exec1", status: "running" }]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(automationTriggerHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "automation.trigger requires an authenticated user",
    );
  });

  // ── not-found guard ───────────────────────────────────────────────────────

  it("throws when the automation is not found in this tenant", async () => {
    mocks.findFirst.mockResolvedValueOnce(undefined);
    await expect(automationTriggerHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.trigger: automation not found: aut_abc",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns execution_id and status on successful trigger", async () => {
    const result = await automationTriggerHandler(BASE_INPUT, CTX);
    expect(result.execution_id).toBe("aur_exec1");
    expect(result.status).toBe("running");
  });

  it("calls findFirst to resolve the automation before inserting the run", async () => {
    await automationTriggerHandler(BASE_INPUT, CTX);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
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
      { automation_id: "aut_abc", payload: { key: "value" } },
      CTX,
    );
    expect(result.execution_id).toBe("aur_exec1");
  });
});
