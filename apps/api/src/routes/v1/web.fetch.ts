import { Hono } from "hono";
import { webFetch } from "@oxagen/oxagen/contracts/web.fetch";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const webFetchRoute = new Hono<AppEnv>();

webFetchRoute.post("/", async (c) => {
  const body = webFetch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(webFetch.name, body, ctx, { surface: "api" });
  return c.json(result);
});
