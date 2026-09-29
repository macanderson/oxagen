import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../app";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  ctx: { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" },
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/context", () => ({
  capabilityContext: () => mocks.ctx,
}));

import { errorMiddleware } from "../../middleware/error";
import {
  ASSISTANT_ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
  assistantAttachmentUploadRoute,
} from "./assistant.attachment.upload";

function post(body: string) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("requestId", "req-1");
    await next();
  });
  a.onError(errorMiddleware);
  a.route("/assistant/attachments/upload", assistantAttachmentUploadRoute);
  return a.fetch(
    new Request("http://localhost/assistant/attachments/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    }),
  );
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("POST /assistant/attachments/upload", () => {
  it("invokes upload_assistant_attachment on the api surface and answers its output", async () => {
    const out = {
      publicId: "gen_abc",
      name: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 2,
      sha256: "0".repeat(64),
    };
    mocks.invoke.mockResolvedValueOnce(out);
    const input = { name: "a.txt", mediaType: "text/plain", data: "aGk=" };
    const res = await post(JSON.stringify(input));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(out);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "upload_assistant_attachment",
      input,
      mocks.ctx,
      { surface: "api" },
    );
  });

  it("refuses a body over the cap with 413 before invoking anything (negative)", async () => {
    const data = "A".repeat(ASSISTANT_ATTACHMENT_UPLOAD_MAX_BODY_BYTES);
    const res = await post(
      JSON.stringify({ name: "big.png", mediaType: "image/png", data }),
    );
    expect(res.status).toBe(413);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
