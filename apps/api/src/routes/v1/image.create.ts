import { Hono } from "hono";
import { imageCreate } from "@oxagen/oxagen/contracts/image.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const imageCreateRoute = new Hono<AppEnv>();

imageCreateRoute.post("/", async (c) => {
  const body = imageCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(imageCreate.name, body, ctx, { surface: "api" });
  return c.json(out);
});
