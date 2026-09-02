/**
 * document.read handler tests.
 *
 * Strategy: mock @oxagen/database withTenantDb and drizzle-orm operators.
 * Assert:
 *   - missing workspaceId → throws
 *   - document not found → throws with document_id in message
 *   - found document → returns contract shape (title, content, metadata, created_at)
 *   - metadata is returned as a plain object
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
              limit: mocks.selectQuery,
            }),
          }),
        }),
      }),
  };
});

import { documentReadHandler } from "./document.read";
import type { CapabilityContext } from "@oxagen/oxagen";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  title: "My Document",
  content: "Some content here.",
  metadata: { version: 1 } as Record<string, unknown>,
  createdAt: new Date("2025-02-20T14:30:00.000Z"),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectQuery.mockResolvedValue([]);
});

describe("documentReadHandler — auth guards", () => {
  it("throws when workspaceId is null", async () => {
    const ctx: CapabilityContext = {
      ...CTX,
      workspaceId: null as unknown as string,
    };
    await expect(
      documentReadHandler({ document_id: "doc_X" }, ctx),
    ).rejects.toThrow("document.read requires a workspace scope");
  });
});

describe("documentReadHandler — not found", () => {
  it("throws when document is not found", async () => {
    mocks.selectQuery.mockResolvedValueOnce([]);
    await expect(
      documentReadHandler({ document_id: "doc_MISSING" }, CTX),
    ).rejects.toThrow('document.read: document "doc_MISSING" not found');
  });
});

describe("documentReadHandler — happy path", () => {
  it("returns contract-shaped output for a found document", async () => {
    const row = makeRow();
    mocks.selectQuery.mockResolvedValueOnce([row]);

    const result = await documentReadHandler({ document_id: "doc_ABC" }, CTX);

    expect(result.title).toBe("My Document");
    expect(result.content).toBe("Some content here.");
    expect(result.created_at).toBe("2025-02-20T14:30:00.000Z");
    expect(result.metadata).toEqual({ version: 1 });
  });

  it("returns empty object when metadata is null", async () => {
    const row = makeRow({ metadata: null });
    mocks.selectQuery.mockResolvedValueOnce([row]);

    const result = await documentReadHandler({ document_id: "doc_ABC" }, CTX);
    expect(result.metadata).toEqual({});
  });

  it("returns content as an empty string when it is empty", async () => {
    const row = makeRow({ content: "" });
    mocks.selectQuery.mockResolvedValueOnce([row]);

    const result = await documentReadHandler({ document_id: "doc_ABC" }, CTX);
    expect(result.content).toBe("");
  });

  it("invokes the query builder exactly once", async () => {
    const row = makeRow();
    mocks.selectQuery.mockResolvedValueOnce([row]);

    await documentReadHandler({ document_id: "doc_ABC" }, CTX);
    expect(mocks.selectQuery).toHaveBeenCalledTimes(1);
  });
});
