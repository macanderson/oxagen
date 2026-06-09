/**
 * Unit tests for miscellaneous route handlers:
 *   archive.create, asset.upload, brandkit.apply,
 *   form.fill, image.generate, svg.generate, video.generate,
 *   documents.generate, documents.pdf.create,
 *   system.install.instructions, workflow (run/status/cancel)
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
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
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

describe("archive.create route", () => {
  const PATH = "/archive/create";
  const VALID_BODY = {
    archiveName: "my-archive",
    entries: [
      { kind: "text", name: "readme.txt", text: "hello" },
    ],
  };

  it("happy path: 200 with archive result", async () => {
    mocks.invoke.mockResolvedValue({ url: "https://cdn.example.com/arc.zip" });
    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'archive.create'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("archive.create");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.archiveName).toBe("my-archive");
  });
});

// ── asset.upload ──────────────────────────────────────────────────────────

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

  it("calls invoke with 'asset.upload'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("asset.upload");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.kind).toBe("image");
    expect(body.sourceUrl).toBe("https://example.com/image.png");
  });

  it("invalid kind → 400", async () => {
    const res = await app.fetch(
      post(PATH, { sourceUrl: "https://example.com/f.mp4", kind: "video" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── brandkit.apply ────────────────────────────────────────────────────────

describe("brandkit.apply route", () => {
  const PATH = "/brandkit/apply";
  const VALID_BODY = {
    workspaceId: "ws-1",
    brandKitId: "bk-1",
    targetFileId: "file-1",
  };

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({
      stub: true,
      applied: false,
      brandKitId: "bk-1",
      targetFileId: "file-1",
    });
    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'brandkit.apply'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("brandkit.apply");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.brandKitId).toBe("bk-1");
  });
});

// ── form.fill ─────────────────────────────────────────────────────────────

describe("form.fill route", () => {
  const PATH = "/forms/fill";
  const VALID_BODY = {
    route: "/settings/org",
    instruction: "Set name to Acme",
    fields: [
      { name: "orgName", type: "text", label: "Org Name", currentValue: "Old" },
    ],
  };

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({ diffs: [] });
    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'form.fill'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("form.fill");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.instruction).toBe("Set name to Acme");
    expect(Array.isArray(body.fields)).toBe(true);
  });

  it("empty fields array → 400", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, fields: [] }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── image.generate ────────────────────────────────────────────────────────

describe("image.generate route", () => {
  const PATH = "/image/generate";

  it("happy path: 200 with image result", async () => {
    mocks.invoke.mockResolvedValue({
      url: "https://cdn.example.com/img.png",
      alt: "Generated image",
    });
    const res = await app.fetch(
      post(PATH, { prompt: "A sunset over the ocean" }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'image.generate'", async () => {
    await app.fetch(post(PATH, { prompt: "A cat" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("image.generate");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.prompt).toBe("A cat");
  });

  it("empty prompt → 400", async () => {
    const res = await app.fetch(post(PATH, { prompt: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── svg.generate ──────────────────────────────────────────────────────────

describe("svg.generate route", () => {
  const PATH = "/svg/generate";

  it("happy path: 200 with SVG", async () => {
    mocks.invoke.mockResolvedValue({
      svg: "<svg/>",
      title: "Logo",
      render: { componentId: "svg-preview", props: {} },
    });
    const res = await app.fetch(
      post(PATH, { prompt: "A simple logo" }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'svg.generate'", async () => {
    await app.fetch(post(PATH, { prompt: "A triangle" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("svg.generate");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.prompt).toBe("A triangle");
  });
});

// ── video.generate ────────────────────────────────────────────────────────

describe("video.generate route", () => {
  const PATH = "/video/generate";

  it("happy path: 200 with video result", async () => {
    mocks.invoke.mockResolvedValue({ status: "queued", assetId: "vas-1" });
    const res = await app.fetch(
      post(PATH, { prompt: "A timelapse of clouds" }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'video.generate'", async () => {
    await app.fetch(
      post(PATH, { prompt: "Ocean waves", durationSeconds: 10 }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("video.generate");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.durationSeconds).toBe(10);
  });

  it("durationSeconds over max → 400", async () => {
    const res = await app.fetch(
      post(PATH, { prompt: "X", durationSeconds: 120 }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── documents.generate ────────────────────────────────────────────────────

describe("documents.generate route", () => {
  const PATH = "/documents/generate";
  const VALID_BODY = {
    kind: "document",
    title: "Q1 Report",
    content: {
      sections: [
        { heading: "Overview", paragraphs: ["This is Q1."] },
      ],
    },
  };

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({
      url: "https://cdn.example.com/doc.docx",
      render: { componentId: "file-attachment", props: {} },
    });
    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'documents.generate'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("documents.generate");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.kind).toBe("document");
    expect(body.title).toBe("Q1 Report");
  });

  it("invalid kind → 400", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, kind: "slideshow" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── documents.pdf.create ─────────────────────────────────────────────────

describe("documents.pdf.create route", () => {
  const PATH = "/documents/pdf";
  const VALID_BODY = {
    title: "My PDF",
    content: {
      sections: [
        { paragraphs: ["Hello world."] },
      ],
    },
  };

  it("happy path: 200", async () => {
    mocks.invoke.mockResolvedValue({
      url: "https://cdn.example.com/doc.pdf",
      render: { componentId: "file-attachment", props: {} },
    });
    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'documents.pdf.create'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("documents.pdf.create");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.title).toBe("My PDF");
  });

  it("empty title → 400", async () => {
    const res = await app.fetch(
      post(PATH, { title: "", content: { sections: [{ paragraphs: ["x"] }] } }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── system.install.instructions ───────────────────────────────────────────

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

  it("calls invoke with 'system.install.instructions'", async () => {
    await app.fetch(
      post(PATH, { client: "cursor", workspaceSlug: "my-ws" }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("system.install.instructions");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.client).toBe("cursor");
    expect(body.workspaceSlug).toBe("my-ws");
  });
});

// ── workflow routes ───────────────────────────────────────────────────────

describe("workflow.run route", () => {
  const PATH = "/workflows";

  it("happy path POST: 200", async () => {
    mocks.invoke.mockResolvedValue({ workflowId: "wfr-1" });
    const res = await app.fetch(
      post(PATH, { goal: "Research AI trends" }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'workflow.run'", async () => {
    await app.fetch(post(PATH, { goal: "Do research", maxParallelism: 5 }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("workflow.run");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.goal).toBe("Do research");
    expect(body.maxParallelism).toBe(5);
  });

  it("empty goal → 400", async () => {
    const res = await app.fetch(post(PATH, { goal: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("workflow.status route", () => {
  const workflowId = "wfr-abc123";
  const PATH = `/workflows/${workflowId}`;

  it("happy path GET /:id: 200 with workflow status", async () => {
    mocks.invoke.mockResolvedValue({ workflow: {}, tasks: [] });
    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'workflow.status' and workflowId", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("workflow.status");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workflowId).toBe(workflowId);
  });
});

describe("workflow.cancel route", () => {
  const workflowId = "wfr-xyz789";
  const PATH = `/workflows/${workflowId}`;

  it("happy path DELETE /:id: 200", async () => {
    mocks.invoke.mockResolvedValue({ cancelled: true });
    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'workflow.cancel' and workflowId", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("workflow.cancel");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workflowId).toBe(workflowId);
  });
});
