import { Hono } from "hono";
import { conversationList } from "@oxagen/oxagen/contracts/conversation.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationListRoute = new Hono<AppEnv>();

conversationListRoute.get("/", async (c) => {
  const input = conversationList.input.parse({
    filter: c.req.query("filter"),
    limit:
      c.req.query("limit") !== undefined
        ? Number(c.req.query("limit"))
        : undefined,
    cursor: c.req.query("cursor") ?? null,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(conversationList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
