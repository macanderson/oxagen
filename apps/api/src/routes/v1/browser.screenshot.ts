import { Hono } from "hono";
import { browserScreenshot } from "@oxagen/oxagen/contracts/browser.screenshot";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserScreenshotRoute = new Hono<AppEnv>();

browserScreenshotRoute.post("/", async (c) => {
  const body = browserScreenshot.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserScreenshot.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
