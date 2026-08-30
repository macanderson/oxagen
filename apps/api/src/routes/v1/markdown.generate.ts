import { Hono } from "hono";
import { markdownGenerate } from "@oxagen/oxagen/contracts/markdown.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const markdownGenerateRoute = new Hono<AppEnv>();

// Markdown document generation — persists raw Markdown as a generated asset.
// Route is org + workspace scoped (see app.ts).
markdownGenerateRoute.post("/", async (c) => {
  const body = markdownGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(markdownGenerate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
