import { Hono } from "hono";
import { imageAnalyze } from "@oxagen/oxagen/contracts/image.analyze";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const imageAnalyzeRoute = new Hono<AppEnv>();

imageAnalyzeRoute.post("/", async (c) => {
  const body = imageAnalyze.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(imageAnalyze.name, body, ctx, { surface: "api" });
  return c.json(out);
});
