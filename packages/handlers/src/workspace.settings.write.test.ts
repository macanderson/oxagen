import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn((_value: unknown) => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { findFirst: vi.fn(), where, set, update };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { workspaces: { findFirst: mocks.findFirst } },
        update: mocks.update,
      }),
  };
});

import { workspaceSettingsWriteHandler } from "./workspace.settings.write";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const EXISTING = { name: "Research", slug: "research", settings: { description: "old" } };

describe("workspace.settings.write handler", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
    mocks.set.mockClear();
    mocks.update.mockClear();
    mocks.where.mockReset();
    mocks.where.mockResolvedValue(undefined);
  });

  it("updates name and merges description into the settings bag", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ name: "Research Lab", slug: "research", settings: { description: "new desc" } });
    const out = await workspaceSettingsWriteHandler({ name: "Research Lab", description: "new desc" }, CTX);

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const setArg = mocks.set.mock.calls[0]![0] as { name?: string; settings?: { description?: string } };
    expect(setArg.name).toBe("Research Lab");
    expect(setArg.settings?.description).toBe("new desc");
    expect(out.name).toBe("Research Lab");
    expect(out.description).toBe("new desc");
  });

  it("clears description by deleting the settings key when passed null", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ name: "Research", slug: "research", settings: {} });
    await workspaceSettingsWriteHandler({ description: null }, CTX);
    const setArg = mocks.set.mock.calls[0]![0] as { settings?: Record<string, unknown> };
    expect(setArg.settings && "description" in setArg.settings).toBe(false);
  });

  it("does not issue an update when no fields are provided", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    const out = await workspaceSettingsWriteHandler({}, CTX);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(out.slug).toBe("research");
  });

  it("maps a unique-violation on slug to a friendly error", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    mocks.where.mockRejectedValueOnce({ code: "23505" });
    await expect(workspaceSettingsWriteHandler({ slug: "taken" }, CTX)).rejects.toThrow(
      /already in use/,
    );
  });

  it("throws when the workspace is not found", async () => {
    mocks.findFirst.mockResolvedValueOnce(undefined);
    await expect(workspaceSettingsWriteHandler({ name: "X" }, CTX)).rejects.toThrow(
      "Workspace not found",
    );
  });
});
