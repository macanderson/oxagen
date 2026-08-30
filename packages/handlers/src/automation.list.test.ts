import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectOrderBy: vi.fn(),
}));

mocks.selectOrderBy.mockResolvedValue([]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: (_cols: unknown) => ({
          from: (_table: unknown) => ({
            innerJoin: (_joinTable: unknown, _cond: unknown) => ({
              where: (_cond2: unknown) => ({
                orderBy: mocks.selectOrderBy,
              }),
            }),
          }),
        }),
      }),
  };
});

import { automationListHandler } from "./automation.list";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

// Row shape mirrors what the handler selects:
//   publicId, triggerType, isEnabled (from playbookTriggers)
//   name, deletedAt (from playbooks)
const makeRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "plt_abc",
  name: "My Automation",
  triggerType: "schedule",
  isEnabled: true,
  deletedAt: null as Date | null,
  ...overrides,
});

describe("automationListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectOrderBy.mockResolvedValue([]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(automationListHandler({}, anonCtx)).rejects.toThrow(
      "automation.list requires an authenticated user",
    );
  });

  // ── empty result ──────────────────────────────────────────────────────────

  it("returns empty array when no automations exist", async () => {
    mocks.selectOrderBy.mockResolvedValueOnce([]);
    const result = await automationListHandler({}, CTX);
    expect(result).toEqual([]);
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("maps rows to contract output shape (id, name, status, triggers)", async () => {
    const row = makeRow();
    mocks.selectOrderBy.mockResolvedValueOnce([row]);
    const result = await automationListHandler({}, CTX);

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe("plt_abc");
    expect(item.name).toBe("My Automation");
    expect(item.status).toBe("active");
    expect(item.triggers).toEqual(["schedule"]);
  });

  it("maps multiple rows correctly", async () => {
    const rows = [
      makeRow({ publicId: "plt_1", name: "First" }),
      makeRow({
        publicId: "plt_2",
        name: "Second",
        isEnabled: false,
        triggerType: "event",
      }),
    ];
    mocks.selectOrderBy.mockResolvedValueOnce(rows);
    const result = await automationListHandler({}, CTX);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("plt_1");
    expect(result[1]!.id).toBe("plt_2");
    expect(result[1]!.status).toBe("inactive");
    expect(result[1]!.triggers).toEqual(["event"]);
  });

  it("maps isEnabled:false to status 'inactive'", async () => {
    const row = makeRow({ isEnabled: false });
    mocks.selectOrderBy.mockResolvedValueOnce([row]);
    const result = await automationListHandler({}, CTX);
    expect(result[0]!.status).toBe("inactive");
  });

  // ── db called ─────────────────────────────────────────────────────────────

  it("invokes the query builder exactly once", async () => {
    await automationListHandler({}, CTX);
    expect(mocks.selectOrderBy).toHaveBeenCalledTimes(1);
  });
});
