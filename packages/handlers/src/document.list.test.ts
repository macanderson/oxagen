/**
 * document.list handler tests.
 *
 * Strategy: mock @oxagen/database withTenantDb and drizzle-orm operators.
 * Assert:
 *   - missing workspaceId → throws
 *   - empty DB → returns { documents: [] }
 *   - rows are mapped to the contract shape (id, title, created_at, updated_at, author)
 *   - author falls back to "unknown" when createdByUserId is null
 *   - query builder is invoked (tenant-scoped filter applied)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectQuery: vi.fn(),
}));

mocks.selectQuery.mockResolvedValue([]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: mocks.selectQuery,
            }),
          }),
        }),
      }),
  };
});

import { documentListHandler } from "./document.list";
import type { CapabilityContext } from "@oxagen/oxagen";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "doc_ABC",
  title: "Test Document",
  createdAt: new Date("2025-01-10T08:00:00.000Z"),
  updatedAt: new Date("2025-01-11T09:00:00.000Z"),
  createdByUserId: "u_1",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectQuery.mockResolvedValue([]);
});

describe("documentListHandler — auth guards", () => {
  it("throws when workspaceId is null", async () => {
    const ctx: CapabilityContext = {
      ...CTX,
      workspaceId: null as unknown as string,
    };
    await expect(documentListHandler({}, ctx)).rejects.toThrow(
      "document.list requires a workspace scope",
    );
  });
});

describe("documentListHandler — empty result", () => {
  it("returns empty documents array when no rows", async () => {
    mocks.selectQuery.mockResolvedValueOnce([]);
    const result = await documentListHandler({}, CTX);
    expect(result.documents).toEqual([]);
  });
});

describe("documentListHandler — happy path", () => {
  it("maps rows to contract shape", async () => {
    const row = makeRow();
    mocks.selectQuery.mockResolvedValueOnce([row]);

    const result = await documentListHandler({}, CTX);

    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0]!;
    expect(doc.id).toBe("doc_ABC");
    expect(doc.title).toBe("Test Document");
    expect(doc.created_at).toBe("2025-01-10T08:00:00.000Z");
    expect(doc.updated_at).toBe("2025-01-11T09:00:00.000Z");
    expect(doc.author).toBe("u_1");
  });

  it("maps author to 'unknown' when createdByUserId is null", async () => {
    const row = makeRow({ createdByUserId: null });
    mocks.selectQuery.mockResolvedValueOnce([row]);

    const result = await documentListHandler({}, CTX);
    expect(result.documents[0]!.author).toBe("unknown");
  });

  it("maps multiple rows in order returned by DB", async () => {
    const rows = [
      makeRow({ publicId: "doc_1", title: "First" }),
      makeRow({ publicId: "doc_2", title: "Second" }),
    ];
    mocks.selectQuery.mockResolvedValueOnce(rows);

    const result = await documentListHandler({}, CTX);
    expect(result.documents).toHaveLength(2);
    expect(result.documents[0]!.id).toBe("doc_1");
    expect(result.documents[1]!.id).toBe("doc_2");
  });

  it("invokes the query builder exactly once", async () => {
    await documentListHandler({}, CTX);
    expect(mocks.selectQuery).toHaveBeenCalledTimes(1);
  });
});
