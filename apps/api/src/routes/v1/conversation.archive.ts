import { Hono } from "hono";
import { conversationArchive } from "@oxagen/oxagen/contracts/conversation.archive";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationArchiveRoute = new Hono<AppEnv>();

conversationArchiveRoute.post("/", async (c) => {
  const body = conversationArchive.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(conversationArchive.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
