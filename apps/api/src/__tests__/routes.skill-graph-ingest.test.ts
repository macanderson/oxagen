/**
 * Unit tests for three thin org-scoped routes that were previously uncovered:
 *   - GET  /skill/export   (skill.export — streams .skill.md as an attachment)
 *   - POST /skill/edit     (skill.edit)
 *
 * Pattern mirrors routes.graph.test.ts: mock at the adapter seam, assert the
 * happy path forwards the invoke result, invoke is called once with the right
 * contract name + parsed input + surface "api", and validation errors 400
 * before invoke is reached.
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
  return { ...real, invoke: mocks.invoke, clearHandlersForTests: vi.fn() };
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
});

async function authGet(path: string): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      headers: { authorization: bearerHeader("oxk_key") },
    }),
  );
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    makeRequest(`${BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

// ── GET /skill/export ─────────────────────────────────────────────────────────

describe("GET /skill/export", () => {
  const validOutput = {
    filename: "my-skill.skill.md",
    content: "---\nname: my-skill\n---\n# Body",
    versionNumber: 3,
  };

  it("streams the exported skill as a text attachment", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const res = await authGet("/skill/export?skillId=skl_ABC");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain(
      "my-skill.skill.md",
    );
    expect(res.headers.get("x-skill-version")).toBe("3");
    expect(await res.text()).toBe(validOutput.content);
    const [name, input] = mocks.invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("export_skill");
    expect(input.skillId).toBe("skl_ABC");
    expect(input.versionNumber).toBeUndefined();
  });

  it("forwards an explicit versionNumber query as a number", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    await authGet("/skill/export?skillId=skl_ABC&versionNumber=2");
    const input = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input.versionNumber).toBe(2);
  });

  it("returns 400 when skillId is missing", async () => {
    const res = await authGet("/skill/export");
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── POST /skill/edit ──────────────────────────────────────────────────────────

describe("POST /skill/edit", () => {
  const validBody = {
    skill_id: "skl_ABC",
    body: "---\nname: my-skill\n---\n# Updated",
  };

  it("forwards a valid edit to skill.edit and returns the result", async () => {
    mocks.invoke.mockResolvedValue({
      version_id: "slv_1",
      version_number: 4,
      skill_id: "skl_ABC",
      activated: true,
    });
    const res = await authPost("/skill/edit", validBody);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { version_id: string };
    expect(out.version_id).toBe("slv_1");
    const [name, input] = mocks.invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("edit_skill");
    expect(input.skill_id).toBe("skl_ABC");
    expect(input.body).toBe(validBody.body);
  });

  it("returns 400 when body is empty", async () => {
    const res = await authPost("/skill/edit", {
      skill_id: "skl_ABC",
      body: "",
    });
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
