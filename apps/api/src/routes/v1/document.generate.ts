import { Hono } from "hono";
import { documentsGenerate } from "@oxagen/oxagen/contracts/document.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const documentsGenerateRoute = new Hono<AppEnv>();

// DOCX / XLSX / PPTX generation from structured content.
// Route is org + workspace scoped (see app.ts).
documentsGenerateRoute.post("/", async (c) => {
  const body = documentsGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(documentsGenerate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
