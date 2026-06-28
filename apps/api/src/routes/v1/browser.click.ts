import { Hono } from "hono";
import { browserClick } from "@oxagen/oxagen/contracts/browser.click";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserClickRoute = new Hono<AppEnv>();

browserClickRoute.post("/", async (c) => {
  const body = browserClick.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserClick.name, body, ctx, { surface: "api" });
  return c.json(out);
});
