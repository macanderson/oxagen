import { Hono } from "hono";
import { notificationsMark } from "@oxagen/oxagen/contracts/notification.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsMarkRoute = new Hono<AppEnv>();

notificationsMarkRoute.post("/", async (c) => {
  const input = notificationsMark.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsMark.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
