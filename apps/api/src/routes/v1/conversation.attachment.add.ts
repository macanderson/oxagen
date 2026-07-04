import { Hono } from "hono";
import { conversationAttachmentAdd } from "@oxagen/oxagen/contracts/conversation.attachment.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationAttachmentAddRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/conversations/attachments
// Body: { conversationId, assetPublicId }
conversationAttachmentAddRoute.post("/", async (c) => {
  const body = conversationAttachmentAdd.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(conversationAttachmentAdd.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
