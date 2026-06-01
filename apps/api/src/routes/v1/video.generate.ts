import { Hono } from "hono";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const videoGenerateRoute = new Hono<AppEnv>();

// Stub video generation: parses the prompt + optional parameters, logs intent,
// and returns a typed queued result with a render directive. Dispatches through
// kernel.invoke() so IAM enforcement, audit, and metering are applied uniformly.
// Route is org + workspace scoped (see app.ts).
videoGenerateRoute.post("/", async (c) => {
  const body = videoGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(videoGenerate.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
