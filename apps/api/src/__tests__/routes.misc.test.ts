/**
 * Unit tests for miscellaneous route handlers:
 *   asset.upload, system.install.instructions
 *
 * The media-generation, form.fill, archive.create and workflow blocks that
 * shared this file went with their capabilities in ADR-043's runtime excision.
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

const BASE = "/v1/test-org/test-ws";

function authHeaders() {
  return { authorization: bearerHeader("oxk_key") };
}

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── archive.create ────────────────────────────────────────────────────────

describe("asset.upload route", () => {
  const PATH = "/asset/upload";
  const VALID_BODY = {
    sourceUrl: "https://example.com/image.png",
    kind: "image",
  };

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({
      storedUrl: "https://cdn.example.com/img.png",
      key: "abc",
    });
    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'upload_asset'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upload_asset");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.kind).toBe("image");
    expect(body.sourceUrl).toBe("https://example.com/image.png");
  });

  it("invalid kind → 400", async () => {
    const res = await app.fetch(
      post(PATH, { sourceUrl: "https://example.com/f.mp4", kind: "audio" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── form.fill ─────────────────────────────────────────────────────────────

describe("system.install.instructions route", () => {
  const PATH = "/system/install-instructions";

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({
      client: "claude-desktop",
      steps: [{ title: "Step 1", body: "Do this" }],
      render: { componentId: "install-instructions", props: {} },
    });
    const res = await app.fetch(post(PATH, { client: "claude-desktop" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_install_instructions'", async () => {
    await app.fetch(post(PATH, { client: "cursor", workspaceSlug: "my-ws" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_install_instructions");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.client).toBe("cursor");
    expect(body.workspaceSlug).toBe("my-ws");
  });
});

// ── workflow routes ───────────────────────────────────────────────────────
