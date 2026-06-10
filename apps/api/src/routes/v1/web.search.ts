import { Hono } from "hono";
import { webSearch } from "@oxagen/oxagen/contracts/web.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const webSearchRoute = new Hono<AppEnv>();

webSearchRoute.post("/", async (c) => {
  const body = webSearch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(webSearch.name, body, ctx, { surface: "api" });
  return c.json(result);
});
