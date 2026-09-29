import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@oxagen/database";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// Each update the handler runs is recorded with its table, its SET values and
// its WHERE clause, and answered with the rows `returning` holds for that
// table.
const mocks = vi.hoisted(() => ({
  updates: [] as Array<{
    table: unknown;
    set: Record<string, unknown>;
    where: unknown;
  }>,
  returning: new Map<unknown, unknown[]>(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: async () => {
            mocks.updates.push({ table, set, where });
            return mocks.returning.get(table) ?? [];
          },
        }),
      }),
    }),
  };
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { conversationDeleteHandler } from "./conversation.delete";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const dialect = new PgDialect();
const CONVERSATIONS = schema.conversations;
const GENERATED_ASSETS = schema.generatedAssets;

const ROW_1 = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  publicId: "cnv_1",
};
const ROW_2 = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000c2",
  publicId: "cnv_2",
};

/** The update the handler ran on `table`, with its WHERE clause rendered. */
function updateOf(table: unknown) {
  const update = mocks.updates.find((u) => u.table === table);
  if (!update) return undefined;
  const q = dialect.sqlToQuery(update.where as SQL);
  return { set: update.set, where: q.sql, params: q.params };
}

describe("conversationDeleteHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updates.length = 0;
    mocks.returning.clear();
    mocks.returning.set(CONVERSATIONS, [ROW_1, ROW_2]);
    mocks.returning.set(GENERATED_ASSETS, [
      { id: "f1" },
      { id: "f2" },
      { id: "f3" },
    ]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      conversationDeleteHandler({ conversationIds: ["cnv_1"] }, anonCtx),
    ).rejects.toThrow("conversation.delete requires an authenticated user");
    expect(mocks.updates).toHaveLength(0);
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns deleted count matching rows affected", async () => {
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_1", "cnv_2"] },
      CTX,
    );
    // The count is conversations, never the files that went with them.
    expect(result.deleted).toBe(2);
  });

  it("returns 0 when no rows match (already deleted or wrong tenant)", async () => {
    mocks.returning.set(CONVERSATIONS, []);
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_missing"] },
      CTX,
    );
    expect(result.deleted).toBe(0);
  });

  it("returns deleted=1 for a single matching conversation", async () => {
    mocks.returning.set(CONVERSATIONS, [ROW_1]);
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_1"] },
      CTX,
    );
    expect(result.deleted).toBe(1);
  });

  // ── tenant scope ──────────────────────────────────────────────────────────

  it("returns 0 when the conversation belongs to a different tenant (update hits 0 rows)", async () => {
    mocks.returning.set(CONVERSATIONS, []);
    const otherCtx: CapabilityContext = { ...CTX, orgId: "org_other" };
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_1"] },
      otherCtx,
    );
    expect(result.deleted).toBe(0);
  });

  it("deletes only the caller's own conversations that are not already deleted", async () => {
    await conversationDeleteHandler({ conversationIds: ["cnv_1"] }, CTX);
    const update = updateOf(CONVERSATIONS);
    expect(update?.where).toMatch(/"public_id" in/);
    expect(update?.where).toMatch(/"org_id" = \$/);
    expect(update?.where).toMatch(/"workspace_id" = \$/);
    expect(update?.where).toMatch(/"user_id" = \$/);
    expect(update?.where).toMatch(/"deleted_at" is null/);
    expect(update?.params).toEqual(
      expect.arrayContaining(["cnv_1", "org_1", "ws_1", "u_1"]),
    );
  });

  // ── files sent in the conversation (#4690) ────────────────────────────────

  it("soft-deletes the files of each conversation it deleted, in the same transaction", async () => {
    await conversationDeleteHandler(
      { conversationIds: ["cnv_1", "cnv_2"] },
      CTX,
    );
    const conversations = updateOf(CONVERSATIONS);
    const files = updateOf(GENERATED_ASSETS);
    expect(files).toBeDefined();
    // The files are marked the way the conversations are: same time, same
    // person.
    expect(files?.set).toEqual({
      deletedAt: expect.any(Date),
      deletedById: "u_1",
      updatedAt: expect.any(Date),
      updatedById: "u_1",
    });
    expect(files?.set.deletedAt).toBe(conversations?.set.deletedAt);
    // Matched by the internal ids the conversation update returned, inside
    // the tenant fence, and never re-stamping a file already deleted.
    expect(files?.where).toMatch(/"conversation_id" in/);
    expect(files?.where).toMatch(/"org_id" = \$/);
    expect(files?.where).toMatch(/"workspace_id" = \$/);
    expect(files?.where).toMatch(/"deleted_at" is null/);
    expect(files?.params).toEqual(
      expect.arrayContaining([ROW_1.id, ROW_2.id, "org_1", "ws_1"]),
    );
    // The public ids the caller sent are not what the files are matched on.
    expect(files?.params).not.toContain("cnv_1");
  });

  it("keeps the files of a conversation the call did not delete (negative)", async () => {
    // cnv_2 was already deleted or is not the caller's: only cnv_1 comes back.
    mocks.returning.set(CONVERSATIONS, [ROW_1]);
    await conversationDeleteHandler(
      { conversationIds: ["cnv_1", "cnv_2"] },
      CTX,
    );
    const files = updateOf(GENERATED_ASSETS);
    expect(files?.params).toContain(ROW_1.id);
    expect(files?.params).not.toContain(ROW_2.id);
  });

  it("touches no file when it deleted no conversation (negative)", async () => {
    mocks.returning.set(CONVERSATIONS, []);
    await conversationDeleteHandler({ conversationIds: ["cnv_1"] }, CTX);
    expect(updateOf(GENERATED_ASSETS)).toBeUndefined();
  });

  // ── DB called once per table ──────────────────────────────────────────────

  it("runs one update for the conversations and one for their files", async () => {
    await conversationDeleteHandler({ conversationIds: ["cnv_1"] }, CTX);
    expect(mocks.updates.map((u) => u.table)).toEqual([
      CONVERSATIONS,
      GENERATED_ASSETS,
    ]);
  });
});
