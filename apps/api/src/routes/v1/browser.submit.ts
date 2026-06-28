import { Hono } from "hono";
import { browserSubmit } from "@oxagen/oxagen/contracts/browser.submit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const browserSubmitRoute = new Hono<AppEnv>();

browserSubmitRoute.post("/", async (c) => {
  const body = browserSubmit.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(browserSubmit.name, body, ctx, { surface: "api" });
  return c.json(out);
});
