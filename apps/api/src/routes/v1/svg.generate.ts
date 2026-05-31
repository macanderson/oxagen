import { Hono } from "hono";
import { svgGenerate } from "@oxagen/oxagen/contracts/svg.generate";
import { svgGenerateHandler } from "@oxagen/handlers/svg.generate";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const svgGenerateRoute = new Hono<AppEnv>();

// Real generative SVG: invokes the model via generateObjectFor, sanitizes the
// output (strips <script> and on* attributes), and returns a render directive
// pointing at the svg-preview chat component. Route is org + workspace scoped.
svgGenerateRoute.post("/", async (c) => {
  const body = svgGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await svgGenerateHandler(body, ctx);
  return c.json(out, 200);
});
