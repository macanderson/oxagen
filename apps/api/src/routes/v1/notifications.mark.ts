import { Hono } from "hono";
import { notificationsMark } from "@oxagen/oxagen/contracts/notifications.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const notificationsMarkRoute = new Hono<AppEnv>();

notificationsMarkRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = notificationsMark.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(notificationsMark.name, input, ctx, { surface: "api" });
  return c.json(out);
});
