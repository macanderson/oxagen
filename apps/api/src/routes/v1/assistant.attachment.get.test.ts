import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
  actingUser: vi.fn(async (_ctx: unknown): Promise<string | null> => "user-1"),
  ctx: {
    orgId: "org-1",
    workspaceId: "ws-1",
    userId: "user-1" as string | null,
    apiKeyId: null as string | null,
  },
}));

vi.mock("@oxagen/handlers", () => {
  class GeneratedAssetNotFoundError extends Error {}
  class GeneratedAssetForbiddenError extends Error {}
  return {
    serveGeneratedAsset: mocks.serve,
    GeneratedAssetNotFoundError,
    GeneratedAssetForbiddenError,
  };
});
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.actingUser,
}));
vi.mock("../../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/context", () => ({
  capabilityContext: () => mocks.ctx,
}));

import {
  GeneratedAssetForbiddenError,
  GeneratedAssetNotFoundError,
} from "@oxagen/handlers";
import { errorMiddleware } from "../../middleware/error";
import { assistantAttachmentGetRoute } from "./assistant.attachment.get";

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("requestId", "req-1");
    await next();
  });
  a.onError(errorMiddleware);
  a.route("/assistant/attachments", assistantAttachmentGetRoute);
  return a;
}

function get(id: string) {
  return app().fetch(
    new Request(`http://localhost/assistant/attachments/${id}`),
  );
}

beforeEach(() => {
  mocks.serve.mockReset();
  mocks.actingUser.mockClear();
  mocks.serve.mockResolvedValue({
    body: new Blob(["hello"]).stream(),
    mimeType: "text/plain",
    sizeBytes: 5n,
    contentDisposition: 'inline; filename="notes.txt"',
  });
});

describe("GET /assistant/attachments/:publicId", () => {
  it("streams the person's own file inside the route's scope, private and unsniffed", async () => {
    const res = await get("gen_abc123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="notes.txt"',
    );
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=0, must-revalidate",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.serve).toHaveBeenCalledWith("gen_abc123", {
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      surface: "api",
      requestId: "req-1",
    });
  });

  it.each([
    ["missing, someone else's, or out of scope", new GeneratedAssetNotFoundError("gen_abc123")],
    ["asked with no identity", new GeneratedAssetForbiddenError()],
  ])(
    "answers the same 404 for a file that is %s (negative)",
    async (_why, err) => {
      mocks.serve.mockRejectedValueOnce(err);
      const res = await get("gen_abc123");
      expect(res.status).toBe(404);
    },
  );

  it("answers 404 for an id that is not an upload id, and reads nothing (negative)", async () => {
    const res = await get("agt_123");
    expect(res.status).toBe(404);
    expect(mocks.serve).not.toHaveBeenCalled();
  });

  it("answers 404 when no person stands behind the request, and reads nothing (negative)", async () => {
    mocks.actingUser.mockResolvedValueOnce(null);
    const res = await get("gen_abc123");
    expect(res.status).toBe(404);
    expect(mocks.serve).not.toHaveBeenCalled();
  });

  it("lets any other failure through as a 500", async () => {
    mocks.serve.mockRejectedValueOnce(new Error("storage down"));
    const res = await get("gen_abc123");
    expect(res.status).toBe(500);
  });
});
