import { Hono } from "hono";
import { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsListRoute = new Hono<AppEnv>();

notificationsListRoute.get("/", async (c) => {
  const unreadOnly = c.req.query("unreadOnly") === "true";
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 50;
  const input = notificationsList.input.parse({ unreadOnly, limit });
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
