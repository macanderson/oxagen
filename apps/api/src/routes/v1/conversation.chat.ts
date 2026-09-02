import { Hono } from "hono";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationChatRoute = new Hono<AppEnv>();

conversationChatRoute.post("/", async (c) => {
  const body = conversationChat.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(conversationChat.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
