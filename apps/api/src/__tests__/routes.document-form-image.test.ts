/**
 * Unit tests for document and image route handlers:
 *   document.create, document.list, document.read,
 *   image.create, image.list, image.analyze
 *
 * Pattern: mock at the adapter seam (@oxagen/auth, @oxagen/oxagen/kernel,
 * @oxagen/billing, @oxagen/handlers, middleware/logger), assert happy path
 * forwards invoke result as JSON, invoke called once with correct contract
 * name + parsed body/query + surface "api", cover route-specific validation
 * edge cases.
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

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    invoke: mocks.invoke,
    clearHandlersForTests: vi.fn(),
  };
});

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

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, query?: Record<string, string>): Request {
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  return makeRequest(`${BASE}${path}${qs}`, {
    method: "GET",
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── document.create ────────────────────────────────────────────────────────

describe("document.create route", () => {
  const PATH = "/document/create";

  it("happy path: invoke called once, returns 200 JSON result", async () => {
    const invokeResult = {
      document_id: "doc-1",
      title: "My Doc",
      created_at: "2024-01-01T00:00:00Z",
      workspace_id: "ws-id-test",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { title: "My Doc", content: "Hello" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'create_document' and surface 'api'", async () => {
    await app.fetch(post(PATH, { title: "My Doc", content: "Hello" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_document");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("forwards parsed body fields to invoke", async () => {
    await app.fetch(
      post(PATH, { title: "Design Doc", content: "Detailed content" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.title).toBe("Design Doc");
    expect(body.content).toBe("Detailed content");
  });

  it("empty title (min 1 violation) → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { title: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing title → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { content: "No title here" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── document.list ──────────────────────────────────────────────────────────

describe("document.list route", () => {
  const PATH = "/document/list";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { documents: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'list_documents' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_documents");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?workspace_id query param is forwarded to invoke", async () => {
    await app.fetch(get(PATH, { workspace_id: "ws-42" }));
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.workspace_id).toBe("ws-42");
  });

  it("no ?workspace_id → invoke receives undefined workspace_id", async () => {
    await app.fetch(get(PATH));
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.workspace_id).toBeUndefined();
  });
});

// ── document.read ──────────────────────────────────────────────────────────

describe("document.read route", () => {
  const PATH = "/document/read";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = {
      title: "My Doc",
      content: "Body text",
      metadata: {},
      created_at: "2024-01-01T00:00:00Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH, { document_id: "doc-abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'read_document' and surface 'api'", async () => {
    await app.fetch(get(PATH, { document_id: "doc-abc" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("read_document");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?document_id query param is forwarded to invoke", async () => {
    await app.fetch(get(PATH, { document_id: "doc-xyz" }));
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.document_id).toBe("doc-xyz");
  });
});

// ── image.create ───────────────────────────────────────────────────────────

describe("image.create route", () => {
  const PATH = "/image/create";

  it("happy path: invoke called once, returns 200 JSON result", async () => {
    const invokeResult = {
      image_id: "img-1",
      url: "https://cdn.example.com/img-1.png",
      created_at: "2024-01-01T00:00:00Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { prompt: "A sunset over the ocean" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'create_image' and surface 'api'", async () => {
    await app.fetch(post(PATH, { prompt: "A red cube" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_image");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("forwards prompt and model to invoke", async () => {
    await app.fetch(
      post(PATH, { prompt: "A blue sphere", model: "flux-2-max" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.prompt).toBe("A blue sphere");
    expect(body.model).toBe("flux-2-max");
  });

  it("empty prompt (min 1 violation) → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { prompt: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid model enum → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { prompt: "test", model: "dall-e-3" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── image.list ─────────────────────────────────────────────────────────────

describe("image.list route", () => {
  const PATH = "/image/list";

  it("happy path GET: returns 200 with invoke result", async () => {
    const invokeResult = { images: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'list_images' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_images");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?workspace_id query param is forwarded to invoke", async () => {
    await app.fetch(get(PATH, { workspace_id: "ws-99" }));
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.workspace_id).toBe("ws-99");
  });

  it("no ?workspace_id → invoke receives undefined workspace_id", async () => {
    await app.fetch(get(PATH));
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.workspace_id).toBeUndefined();
  });
});

// ── image.analyze ──────────────────────────────────────────────────────────

describe("image.analyze route", () => {
  const PATH = "/image/analyze";

  it("happy path: invoke called once, returns 200 JSON result", async () => {
    const invokeResult = {
      analysis: "A scenic landscape",
      tags: ["nature", "outdoor"],
      description: "Rolling green hills under a blue sky",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { image_id: "img-abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with contract name 'analyze_image' and surface 'api'", async () => {
    await app.fetch(post(PATH, { image_id: "img-abc" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("analyze_image");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("forwards image_id to invoke", async () => {
    await app.fetch(post(PATH, { image_id: "img-xyz" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.image_id).toBe("img-xyz");
  });

  it("missing image_id → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
