import { Hono } from "hono";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { videoGenerateHandler } from "@oxagen/handlers/video.generate";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const videoGenerateRoute = new Hono<AppEnv>();

// Stub video generation: parses the prompt + optional parameters, logs intent,
// and returns a typed queued result with a render directive. Route is org +
// workspace scoped (see app.ts).
videoGenerateRoute.post("/", async (c) => {
  const body = videoGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await videoGenerateHandler(body, ctx);
  return c.json(out, 200);
});
