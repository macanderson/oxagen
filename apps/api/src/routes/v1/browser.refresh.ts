import { Hono } from "hono";
import { browserRefresh } from "@oxagen/oxagen/contracts/browser.refresh";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserRefreshRoute = new Hono<AppEnv>();

browserRefreshRoute.post("/", async (c) => {
  const body = browserRefresh.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserRefresh.name, body, ctx, { surface: "api" });
  return c.json(out);
});
