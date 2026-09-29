import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
  ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS,
  assistantAttachmentUpload,
} from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Store one file a person attaches to a message for the in-app assistant
 * (#4690, ADR-222). The body is the contract's input: the file's name, its
 * declared type and its bytes as base64. The answer carries the `gen_` id the
 * message then sends in `attachments`.
 */
export const assistantAttachmentUploadRoute = new Hono<AppEnv>();

/**
 * The largest body the route reads: the base64 cap plus room for the name and
 * the type. A larger body is refused before it is buffered, so an oversized
 * upload costs the server nothing.
 */
export const ASSISTANT_ATTACHMENT_UPLOAD_MAX_BODY_BYTES =
  ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS + 16 * 1024;

assistantAttachmentUploadRoute.use(
  "*",
  bodyLimit({
    maxSize: ASSISTANT_ATTACHMENT_UPLOAD_MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, {
        message: "The file is larger than 4 MB.",
      });
    },
  }),
);

assistantAttachmentUploadRoute.post("/", async (c) => {
  const input = assistantAttachmentUpload.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const output = await invoke(assistantAttachmentUpload.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
