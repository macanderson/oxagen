import { Hono } from "hono";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const videoGenerateRoute = new Hono<AppEnv>();

// Video generation: parses the prompt + optional parameters and dispatches an
// asynchronous render. The handler creates a `pending` generated_assets row
// (stable serving URL) and enqueues `agent/video.render` on Inngest, which
// generates the video, uploads to blob, and flips the row to `ready`. Returns a
// typed queued result (status, jobId, serveUrl, render directive) immediately —
// it does not await the render. Dispatches through kernel.invoke() so IAM
// enforcement, audit, and metering are applied uniformly. Route is org +
// workspace scoped (see app.ts).
videoGenerateRoute.post("/", async (c) => {
  const body = videoGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(videoGenerate.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
