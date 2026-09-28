import { Hono } from "hono";
import { assistantAttachmentUpload } from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Store one file a person attaches to a message for the in-app assistant
 * (#4690, ADR-221). The body is the contract's input: the file's name, its
 * declared type and its bytes as base64. The answer carries the `gen_` id the
 * message then sends in `attachments`.
 */
export const assistantAttachmentUploadRoute = new Hono<AppEnv>();

assistantAttachmentUploadRoute.post("/", async (c) => {
  const input = assistantAttachmentUpload.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const output = await invoke(assistantAttachmentUpload.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
