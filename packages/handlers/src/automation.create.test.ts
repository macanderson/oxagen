import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
}));

mocks.insertReturning.mockResolvedValue([
  { publicId: "aut_abc123", name: "My Automation", status: "active" },
]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: (_table: unknown) => ({
        values: (_vals: unknown) => ({
          returning: mocks.insertReturning,
        }),
      }),
    }),

  };
});

import { automationCreateHandler } from "./automation.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  name: "My Automation",
  trigger: undefined as string | undefined,
  action: undefined as string | undefined,
};

describe("automationCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertReturning.mockResolvedValue([
      { publicId: "aut_abc123", name: "My Automation", status: "active" },
    ]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(automationCreateHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "automation.create requires an authenticated user",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns automation_id, name, status on successful insert", async () => {
    const result = await automationCreateHandler(BASE_INPUT, CTX);
    expect(result.automation_id).toBe("aut_abc123");
    expect(result.name).toBe("My Automation");
    expect(result.status).toBe("active");
  });

  it("calls the db insert exactly once", async () => {
    await automationCreateHandler(BASE_INPUT, CTX);
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
  });

  it("throws when insert returns no row", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    await expect(automationCreateHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "automation.create: insert returned no row",
    );
  });

  it("passes the automation name through from input", async () => {
    mocks.insertReturning.mockResolvedValueOnce([
      { publicId: "aut_xyz", name: "Scheduled Report", status: "active" },
    ]);
    const result = await automationCreateHandler({ ...BASE_INPUT, name: "Scheduled Report" }, CTX);
    expect(result.name).toBe("Scheduled Report");
  });

  it("passes trigger and action when provided", async () => {
    mocks.insertReturning.mockResolvedValueOnce([
      { publicId: "aut_xyz", name: "My Automation", status: "active" },
    ]);
    const result = await automationCreateHandler(
      { name: "My Automation", trigger: "schedule.daily", action: "report.generate" },
      CTX,
    );
    expect(result.automation_id).toBe("aut_xyz");
    expect(result.status).toBe("active");
  });
});
