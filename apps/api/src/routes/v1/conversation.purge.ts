import { Hono } from "hono";
import { conversationPurge } from "@oxagen/oxagen/contracts/conversation.purge";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationPurgeRoute = new Hono<AppEnv>();

conversationPurgeRoute.post("/", async (c) => {
  const body = conversationPurge.input.parse(
    await c.req.json().catch(() => ({})),
  );
  const ctx = capabilityContext(c);
  const out = await invoke(conversationPurge.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
