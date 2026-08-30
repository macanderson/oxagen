/**
 * Unit tests for src/routes/v1/conversation.list.ts
 *
 * Covers:
 * - limit="20" → passes 20 to invoke
 * - limit absent → passes schema default (50)
 * - limit="abc" → NaN → Zod 400
 * - cursor absent → null
 * - filter forwarded to invoke
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

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

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const CONV_LIST_PATH = "/v1/test-org/test-ws/conversations";

const VALID_INVOKE_RESULT = { conversations: [], nextCursor: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue(VALID_INVOKE_RESULT);
});

function makeConvRequest(qs?: Record<string, string>): Request {
  const params = new URLSearchParams(qs ?? {});
  const url =
    qs && Object.keys(qs).length > 0
      ? `${CONV_LIST_PATH}?${params.toString()}`
      : CONV_LIST_PATH;
  return makeRequest(url, {
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

describe("conversation.list route — query parsing", () => {
  it("limit='20' → invoke receives limit: 20", async () => {
    const res = await app.fetch(makeConvRequest({ limit: "20" }));
    expect(res.status).toBe(200);
    // Check the input passed to invoke
    const invokeInput = mocks.invoke.mock.calls[0]?.[1] as
      | { limit: number }
      | undefined;
    expect(invokeInput?.limit).toBe(20);
  });

  it("limit absent → invoke receives schema default (50)", async () => {
    const res = await app.fetch(makeConvRequest());
    expect(res.status).toBe(200);
    const invokeInput = mocks.invoke.mock.calls[0]?.[1] as
      | { limit: number }
      | undefined;
    expect(invokeInput?.limit).toBe(50);
  });

  it("limit='abc' → NaN → Zod validation → 400", async () => {
    const res = await app.fetch(makeConvRequest({ limit: "abc" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("cursor absent → invoke receives cursor: null", async () => {
    const res = await app.fetch(makeConvRequest());
    expect(res.status).toBe(200);
    const invokeInput = mocks.invoke.mock.calls[0]?.[1] as
      | { cursor: string | null }
      | undefined;
    expect(invokeInput?.cursor).toBeNull();
  });

  it("cursor provided → invoke receives the cursor string", async () => {
    const res = await app.fetch(
      makeConvRequest({ cursor: "2024-01-01T00:00:00Z" }),
    );
    expect(res.status).toBe(200);
    const invokeInput = mocks.invoke.mock.calls[0]?.[1] as
      | { cursor: string | null }
      | undefined;
    expect(invokeInput?.cursor).toBe("2024-01-01T00:00:00Z");
  });

  it("filter='archived' → invoke receives filter: 'archived'", async () => {
    const res = await app.fetch(makeConvRequest({ filter: "archived" }));
    expect(res.status).toBe(200);
    const invokeInput = mocks.invoke.mock.calls[0]?.[1] as
      | { filter: string }
      | undefined;
    expect(invokeInput?.filter).toBe("archived");
  });

  it("filter absent → invoke receives schema default 'active'", async () => {
    const res = await app.fetch(makeConvRequest());
    expect(res.status).toBe(200);
    const invokeInput = mocks.invoke.mock.calls[0]?.[1] as
      | { filter: string }
      | undefined;
    expect(invokeInput?.filter).toBe("active");
  });

  it("invoke result is forwarded as JSON response", async () => {
    const conversations = [
      {
        publicId: "conv-1",
        title: "My conversation",
        status: "active",
        archivedAt: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ];
    mocks.invoke.mockResolvedValue({ conversations, nextCursor: "cursor-val" });

    const res = await app.fetch(makeConvRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: unknown[];
      nextCursor: string;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.nextCursor).toBe("cursor-val");
  });
});
