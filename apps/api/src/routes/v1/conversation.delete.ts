import { Hono } from "hono";
import { conversationDelete } from "@oxagen/oxagen/contracts/conversation.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationDeleteRoute = new Hono<AppEnv>();

conversationDeleteRoute.post("/", async (c) => {
  const body = conversationDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(conversationDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
