import { Hono } from "hono";
import { conversationRename } from "@oxagen/oxagen/contracts/conversation.rename";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationRenameRoute = new Hono<AppEnv>();

conversationRenameRoute.patch("/", async (c) => {
  const body = conversationRename.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(conversationRename.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
