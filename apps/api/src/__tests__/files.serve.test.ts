/**
 * Unit tests for src/routes/v1/files.serve.ts
 *
 * Security focus:
 * - IDOR: FileNotFoundError AND FileForbiddenError BOTH → identical 404 "File not found"
 *   (must NOT distinguish, must NOT return 403)
 * - Other errors bubble up (→ 500)
 * - Security headers present: x-content-type-options:nosniff, cache-control private,
 *   content-disposition
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so the error classes and mocks are available when vi.mock factories run
const mocks = vi.hoisted(() => {
  class FileNotFoundError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileNotFoundError"; }
  }
  class FileForbiddenError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileForbiddenError"; }
  }
  return {
    resolveApiKey: vi.fn(),
    resolveSession: vi.fn(),
    parseSessionCookie: vi.fn(),
    resolveOrgScope: vi.fn(),
    resolveWorkspaceScope: vi.fn(),
    invoke: vi.fn(),
    serveFile: vi.fn(),
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
    FileNotFoundError,
    FileForbiddenError,
  };
});

// Expose the error classes at module scope for use in test body
const { FileNotFoundError, FileForbiddenError } = mocks;

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  verifyStripeSignature: mocks.verifyStripeSignature,
  processStripeEvent: mocks.processStripeEvent,
  bootstrapBillingRuntime: vi.fn(),
}));

vi.mock("@oxagen/handlers", () => ({
  serveFile: mocks.serveFile,
  FileNotFoundError: mocks.FileNotFoundError,
  FileForbiddenError: mocks.FileForbiddenError,
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const FILE_PATH = "/v1/test-org/test-ws/files/file-abc123";

function makeFileRequest(): Request {
  return makeRequest(FILE_PATH, {
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

// A minimal valid serveFile result
function makeServeFileResult(overrides?: {
  mimeType?: string;
  sizeBytes?: number;
  contentDisposition?: string;
}) {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("file-content"));
        controller.close();
      },
    }),
    mimeType: overrides?.mimeType ?? "image/png",
    sizeBytes: overrides?.sizeBytes ?? 100,
    contentDisposition: overrides?.contentDisposition ?? "attachment; filename=\"file.png\"",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
});

// ── IDOR defence ──────────────────────────────────────────────────────────────

describe("files.serve — IDOR: FileNotFoundError → 404", () => {
  it("throws FileNotFoundError → 404 'File not found' (not 500)", async () => {
    mocks.serveFile.mockRejectedValue(new FileNotFoundError("File abc123 not found"));
    const res = await app.fetch(makeFileRequest());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("File not found");
  });
});

describe("files.serve — IDOR: FileForbiddenError → 404 (not 403)", () => {
  it("throws FileForbiddenError → SAME 404 'File not found' (IDOR defence)", async () => {
    mocks.serveFile.mockRejectedValue(new FileForbiddenError("Access denied"));
    const res = await app.fetch(makeFileRequest());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("File not found");
  });

  it("FileForbiddenError must NOT produce a 403 status", async () => {
    mocks.serveFile.mockRejectedValue(new FileForbiddenError("user is not allowed"));
    const res = await app.fetch(makeFileRequest());
    expect(res.status).not.toBe(403);
  });

  it("FileNotFoundError and FileForbiddenError produce identical responses", async () => {
    mocks.serveFile.mockRejectedValue(new FileNotFoundError("gone"));
    const res1 = await app.fetch(makeFileRequest());
    const body1 = (await res1.json()) as { error: { message: string } };

    mocks.serveFile.mockRejectedValue(new FileForbiddenError("forbidden"));
    const res2 = await app.fetch(makeFileRequest());
    const body2 = (await res2.json()) as { error: { message: string } };

    expect(res1.status).toBe(res2.status);
    expect(body1.error.message).toBe(body2.error.message);
  });
});

describe("files.serve — other errors bubble up", () => {
  it("unexpected error → 500", async () => {
    mocks.serveFile.mockRejectedValue(new Error("DB connection pool exhausted"));
    const res = await app.fetch(makeFileRequest());
    expect(res.status).toBe(500);
  });
});

// ── Security headers on success ───────────────────────────────────────────────

describe("files.serve — security headers on success", () => {
  beforeEach(() => {
    mocks.serveFile.mockResolvedValue(makeServeFileResult());
  });

  it("includes x-content-type-options: nosniff", async () => {
    const res = await app.fetch(makeFileRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("includes cache-control with 'private'", async () => {
    const res = await app.fetch(makeFileRequest());
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("includes content-disposition header", async () => {
    const res = await app.fetch(makeFileRequest());
    expect(res.headers.get("content-disposition")).toBeTruthy();
    expect(res.headers.get("content-disposition")).toBe("attachment; filename=\"file.png\"");
  });

  it("returns 200 with the correct mime type", async () => {
    const res = await app.fetch(makeFileRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("custom contentDisposition is forwarded", async () => {
    mocks.serveFile.mockResolvedValue(
      makeServeFileResult({ contentDisposition: "inline; filename=\"preview.pdf\"" }),
    );
    const res = await app.fetch(makeFileRequest());
    expect(res.headers.get("content-disposition")).toBe("inline; filename=\"preview.pdf\"");
  });
});
