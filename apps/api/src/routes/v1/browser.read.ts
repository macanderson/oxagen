import { Hono } from "hono";
import { browserRead } from "@oxagen/oxagen/contracts/browser.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserReadRoute = new Hono<AppEnv>();

browserReadRoute.post("/", async (c) => {
  const body = browserRead.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserRead.name, body, ctx, { surface: "api" });
  return c.json(out);
});
