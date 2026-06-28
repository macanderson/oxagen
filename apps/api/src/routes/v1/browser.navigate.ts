import { Hono } from "hono";
import { browserNavigate } from "@oxagen/oxagen/contracts/browser.navigate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserNavigateRoute = new Hono<AppEnv>();

browserNavigateRoute.post("/", async (c) => {
  const body = browserNavigate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserNavigate.name, body, ctx, { surface: "api" });
  return c.json(out);
});
