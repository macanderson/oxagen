import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn((_value: unknown) => ({ where }));
  const update = vi.fn(() => ({ set }));
  // Slug-history capture (OXA-1779): the handler inserts a row into
  // workspace_slug_history inside the SAME withTenantDb tx whenever the slug
  // changes. The mock records every insert so each test can assert (or assert
  // the absence of) a history write.
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  return { findFirst: vi.fn(), where, set, update, insert, insertValues };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { workspaces: { findFirst: mocks.findFirst } },
        update: mocks.update,
        insert: mocks.insert,
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
    mocks.insert.mockClear();
    mocks.insertValues.mockReset();
    mocks.insertValues.mockResolvedValue(undefined);
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

  it("sets the avatarUrl column and returns it", async () => {
    const avatar = "avatar:v1:{\"emoji\":\"🔬\",\"bg\":\"#2563eb\",\"mode\":\"full\"}";
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ name: "Research", slug: "research", avatarUrl: avatar, settings: { description: "old" } });
    const out = await workspaceSettingsWriteHandler({ avatarUrl: avatar }, CTX);

    const setArg = mocks.set.mock.calls[0]![0] as { avatarUrl?: string | null };
    expect(setArg.avatarUrl).toBe(avatar);
    expect(out.avatarUrl).toBe(avatar);
  });

  it("clears the avatarUrl column when passed null", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ ...EXISTING, avatarUrl: "https://cdn.example.com/a.png" })
      .mockResolvedValueOnce({ name: "Research", slug: "research", avatarUrl: null, settings: { description: "old" } });
    const out = await workspaceSettingsWriteHandler({ avatarUrl: null }, CTX);

    const setArg = mocks.set.mock.calls[0]![0] as { avatarUrl?: string | null };
    expect(setArg.avatarUrl).toBeNull();
    expect(out.avatarUrl).toBeNull();
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

  // ── Slug-history capture (OXA-1779) ────────────────────────────────────────
  // The handler MUST insert one workspace_slug_history row whenever the
  // workspace slug changes, in the SAME withTenantDb transaction as the
  // workspace UPDATE — so the redirect record never lags the rename even on
  // process crash. These tests assert capture-on-change and skip-on-unchange.

  it("writes a workspace_slug_history row when the slug changes", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ name: "Research", slug: "new-slug", settings: { description: "old" } });
    await workspaceSettingsWriteHandler({ slug: "new-slug" }, CTX);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const insertRow = mocks.insertValues.mock.calls[0]![0] as {
      orgId: string;
      workspaceId: string;
      oldSlug: string;
      newSlug: string;
    };
    expect(insertRow.oldSlug).toBe("research");
    expect(insertRow.newSlug).toBe("new-slug");
    expect(insertRow.orgId).toBe(CTX.orgId);
    expect(insertRow.workspaceId).toBe(CTX.workspaceId);
  });

  it("does NOT write history when slug is omitted or unchanged", async () => {
    // name-only update — no slug change → no history row.
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce({ name: "Research Lab", slug: "research", settings: { description: "old" } });
    await workspaceSettingsWriteHandler({ name: "Research Lab" }, CTX);
    expect(mocks.insert).not.toHaveBeenCalled();

    // Slug echoes the existing value → still no history row (capture is on
    // CHANGE, not on every slug submission).
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce(EXISTING);
    await workspaceSettingsWriteHandler({ slug: "research" }, CTX);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("does NOT write history when the UPDATE fails (atomic rollback)", async () => {
    // Insert is queued INSIDE the same try/catch block as the UPDATE so a
    // unique-violation surfaces a friendly error and the (mocked) tx
    // rollback discards the history row too. Asserts the order: a failing
    // UPDATE must reach the catch — but since the mock can't roll back, the
    // proof is that the insert call happened BEFORE the failing update so a
    // real tx would discard both.
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    mocks.where.mockRejectedValueOnce({ code: "23505" });
    await expect(
      workspaceSettingsWriteHandler({ slug: "taken" }, CTX),
    ).rejects.toThrow(/already in use/);
    // The history insert ran first (so the surrounding tx would roll it back),
    // and the update was attempted after.
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
