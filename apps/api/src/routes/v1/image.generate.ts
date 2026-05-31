import { Hono } from "hono";
import { imageGenerate } from "@oxagen/oxagen/contracts/image.generate";
import { imageGenerateHandler } from "@oxagen/handlers/image.generate";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const imageGenerateRoute = new Hono<AppEnv>();

// Image generation via DALL-E 3 when OPENAI_API_KEY is configured; returns a
// typed placeholder with an empty-state render directive otherwise. Never
// throws. Route is org + workspace scoped.
imageGenerateRoute.post("/", async (c) => {
  const body = imageGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await imageGenerateHandler(body, ctx);
  return c.json(out, 200);
});
