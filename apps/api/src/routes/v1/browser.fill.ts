import { Hono } from "hono";
import { browserFill } from "@oxagen/oxagen/contracts/browser.fill";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserFillRoute = new Hono<AppEnv>();

browserFillRoute.post("/", async (c) => {
  const body = browserFill.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserFill.name, body, ctx, { surface: "api" });
  return c.json(out);
});
