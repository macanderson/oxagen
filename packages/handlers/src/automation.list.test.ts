import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectOrderBy: vi.fn(),
}));

mocks.selectOrderBy.mockResolvedValue([]);

<<<<<<< HEAD
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
=======
vi.mock("@oxagen/database", () => ({
>>>>>>> feat/hardening-cost-prompts-motion-rebrand
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: (_cols: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            orderBy: mocks.selectOrderBy,
          }),
        }),
      }),
    }),
<<<<<<< HEAD

  };
=======
  schema: {
    automations: {
      publicId: "publicId",
      name: "name",
      status: "status",
      triggerConfig: "triggerConfig",
      orgId: "orgId",
      workspaceId: "workspaceId",
      deletedAt: "deletedAt",
      createdAt: "createdAt",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { and: orig.and, eq: orig.eq, desc: orig.desc, isNull: orig.isNull };
>>>>>>> feat/hardening-cost-prompts-motion-rebrand
});

import { automationListHandler } from "./automation.list";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

<<<<<<< HEAD
import { TEST_CTX as CTX } from "./test-utils/fixtures";
=======
const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
>>>>>>> feat/hardening-cost-prompts-motion-rebrand

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "aut_abc",
  name: "My Automation",
  status: "active",
  triggerConfig: ["schedule.daily"],
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
    expect(item.id).toBe("aut_abc");
    expect(item.name).toBe("My Automation");
    expect(item.status).toBe("active");
    expect(item.triggers).toEqual(["schedule.daily"]);
  });

  it("maps multiple rows correctly", async () => {
    const rows = [
      makeRow({ publicId: "aut_1", name: "First" }),
      makeRow({ publicId: "aut_2", name: "Second", status: "paused", triggerConfig: [] }),
    ];
    mocks.selectOrderBy.mockResolvedValueOnce(rows);
    const result = await automationListHandler({}, CTX);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("aut_1");
    expect(result[1]!.id).toBe("aut_2");
    expect(result[1]!.status).toBe("paused");
    expect(result[1]!.triggers).toEqual([]);
  });

  it("coerces non-array triggerConfig to empty array", async () => {
    const row = makeRow({ triggerConfig: null });
    mocks.selectOrderBy.mockResolvedValueOnce([row]);
    const result = await automationListHandler({}, CTX);
    expect(result[0]!.triggers).toEqual([]);
  });

  // ── db called ─────────────────────────────────────────────────────────────

  it("invokes the query builder exactly once", async () => {
    await automationListHandler({}, CTX);
    expect(mocks.selectOrderBy).toHaveBeenCalledTimes(1);
  });
});
