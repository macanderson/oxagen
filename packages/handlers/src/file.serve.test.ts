/**
 * Unit tests for serveFile (packages/handlers/src/file.serve.ts).
 *
 * Mocks:
 *  - @oxagen/database  → db() select chains + schema symbols
 *  - @oxagen/storage   → storage().get() + StorageNotFoundError
 *  - @oxagen/telemetry → insertEvents (fire-and-forget, must not throw)
 *  - node:crypto       → randomUUID (deterministic in tests)
 *
 * Scenarios covered:
 *  1. API surface — org mismatch → FileNotFoundError
 *  2. API surface — workspace mismatch → FileNotFoundError
 *  3. API surface — org match, workspace match → happy path
 *  4. App surface — user is not a member → FileNotFoundError
 *  5. App surface — user is a member → happy path
 *  6. No identity (neither orgId nor userId) → FileForbiddenError
 *  7. File row absent in DB → FileNotFoundError
 *  8. Storage object missing (StorageNotFoundError) → FileNotFoundError
 *  9. Happy path: telemetry failure does not break the response
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileServePrincipal } from "./file.serve";

// ── Hoisted mock state ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  storageGet: vi.fn(),
  insertEvents: vi.fn(),
}));

// ── @oxagen/database mock ─────────────────────────────────────────────────────
//
// db().select().from().where().limit() is the query shape used by serveFile.
// We model a fluent builder where each method returns the next step, and
// the final `.limit(n)` is a Promise that resolves to the row array.

function makeSelectBuilder(rows: unknown[]): unknown {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

vi.mock("@oxagen/database", () => ({
  db: () => ({ select: mocks.dbSelect }),
  // withSystemDb passthrough: the handler uses withSystemDb for file row
  // lookup and membership check (OXA-1515). Forward fn to a fake tx that
  // exposes the same select mock so existing test chains apply.
  withSystemDb: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
    fn({ select: mocks.dbSelect } as unknown as Record<string, unknown>),
  schema: {
    files: {
      publicId: "files.publicId",
      orgId: "files.orgId",
      workspaceId: "files.workspaceId",
    },
    orgUsers: {
      id: "orgUsers.id",
      orgId: "orgUsers.orgId",
      userId: "orgUsers.userId",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ $type: "eq", col, val }),
  and: (...args: unknown[]) => ({ $type: "and", args }),
}));

// ── @oxagen/storage mock ──────────────────────────────────────────────────────

vi.mock("@oxagen/storage", async () => {
  class StorageNotFoundError extends Error {
    readonly notFound = true as const;
    constructor(key: string) {
      super(`Storage object not found: ${key}`);
      this.name = "StorageNotFoundError";
    }
  }
  return {
    storage: () => ({ get: mocks.storageGet }),
    StorageNotFoundError,
  };
});

// ── @oxagen/telemetry mock ────────────────────────────────────────────────────

vi.mock("@oxagen/telemetry", () => ({
  insertEvents: mocks.insertEvents,
}));

// ── node:crypto mock ──────────────────────────────────────────────────────────

vi.mock("node:crypto", () => ({
  randomUUID: () => "00000000-0000-0000-0000-000000000001",
}));

// ── Import subject under test (after all vi.mock() calls) ─────────────────────

const { serveFile, FileNotFoundError, FileForbiddenError } = await import("./file.serve");
const { StorageNotFoundError } = await import("@oxagen/storage");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FILE_ROW = {
  id: "internal-uuid",
  publicId: "fil_TEST01",
  orgId: "org-aaa",
  workspaceId: "ws-bbb",
  storageKey: "uploads/fil_TEST01/doc.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024n,
  storageProvider: "vercel-blob",
  storageBucket: "default",
  checksumSha256: "abc",
  uploadedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByUserId: null,
  updatedByUserId: null,
};

const STREAM_BODY = new ReadableStream<Uint8Array>();

function makeApiPrincipal(overrides: Partial<FileServePrincipal> = {}): FileServePrincipal {
  return { orgId: "org-aaa", workspaceId: "ws-bbb", surface: "api", requestId: "req-1", ...overrides };
}

function makeAppPrincipal(overrides: Partial<FileServePrincipal> = {}): FileServePrincipal {
  return { userId: "user-xyz", surface: "app", requestId: "req-2", ...overrides };
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: file row found, then membership found (two separate select calls)
  mocks.dbSelect
    .mockReturnValueOnce(makeSelectBuilder([FILE_ROW]))  // files query
    .mockReturnValueOnce(makeSelectBuilder([{ id: "oru-1" }]));  // org_users query
  // Default storage response
  mocks.storageGet.mockResolvedValue({
    body: STREAM_BODY,
    contentType: "application/pdf",
    sizeBytes: 1024,
  });
  // Default telemetry: resolves cleanly
  mocks.insertEvents.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("serveFile", () => {

  // ── File not in DB ────────────────────────────────────────────────────────

  it("throws FileNotFoundError when the file row is absent in the DB", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([])); // no file row

    await expect(serveFile("fil_MISSING", makeApiPrincipal())).rejects.toBeInstanceOf(FileNotFoundError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  // ── API surface authz ─────────────────────────────────────────────────────

  it("API — org mismatch → FileNotFoundError (no storage call, no telemetry)", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    const principal = makeApiPrincipal({ orgId: "org-WRONG" });
    await expect(serveFile("fil_TEST01", principal)).rejects.toBeInstanceOf(FileNotFoundError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.insertEvents).not.toHaveBeenCalled();
  });

  it("API — workspace mismatch → FileNotFoundError", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    const principal = makeApiPrincipal({ orgId: "org-aaa", workspaceId: "ws-WRONG" });
    await expect(serveFile("fil_TEST01", principal)).rejects.toBeInstanceOf(FileNotFoundError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("API — org match, no workspaceId on principal → passes authz without workspace check", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    const principal = makeApiPrincipal({ workspaceId: undefined });
    const result = await serveFile("fil_TEST01", principal);

    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(1024n);
    expect(result.body).toBe(STREAM_BODY);
  });

  it("API — org + workspace match → returns stream and correct metadata", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    const result = await serveFile("fil_TEST01", makeApiPrincipal());

    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(1024n);
    expect(result.body).toBe(STREAM_BODY);
    expect(mocks.storageGet).toHaveBeenCalledWith("uploads/fil_TEST01/doc.pdf");
  });

  // ── App surface authz ─────────────────────────────────────────────────────

  it("App — non-member → FileNotFoundError (membership query returns empty)", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect
      .mockReturnValueOnce(makeSelectBuilder([FILE_ROW]))    // files
      .mockReturnValueOnce(makeSelectBuilder([]));            // org_users: not a member

    await expect(serveFile("fil_TEST01", makeAppPrincipal())).rejects.toBeInstanceOf(FileNotFoundError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.insertEvents).not.toHaveBeenCalled();
  });

  it("App — member → returns stream and correct metadata", async () => {
    const result = await serveFile("fil_TEST01", makeAppPrincipal());

    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(1024n);
    expect(result.body).toBe(STREAM_BODY);
  });

  // ── No identity ───────────────────────────────────────────────────────────

  it("throws FileForbiddenError when neither orgId nor userId is present", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    const principal: FileServePrincipal = { surface: "api" };
    await expect(serveFile("fil_TEST01", principal)).rejects.toBeInstanceOf(FileForbiddenError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  // ── Storage missing ───────────────────────────────────────────────────────

  it("maps StorageNotFoundError to FileNotFoundError (orphaned DB row)", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    mocks.storageGet.mockRejectedValue(new StorageNotFoundError("uploads/fil_TEST01/doc.pdf"));

    await expect(serveFile("fil_TEST01", makeApiPrincipal())).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("propagates unexpected storage errors (not StorageNotFoundError)", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    mocks.storageGet.mockRejectedValue(new Error("storage network timeout"));

    await expect(serveFile("fil_TEST01", makeApiPrincipal())).rejects.toThrow("storage network timeout");
  });

  // ── Telemetry ─────────────────────────────────────────────────────────────

  it("telemetry failure does not break the response — still returns stream", async () => {
    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([FILE_ROW]));

    mocks.insertEvents.mockRejectedValue(new Error("clickhouse down"));

    // Should NOT throw — telemetry is fire-and-forget
    const result = await serveFile("fil_TEST01", makeApiPrincipal());
    expect(result.body).toBe(STREAM_BODY);
  });
});
