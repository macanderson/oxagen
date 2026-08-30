import { Hono } from "hono";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/document.pdf.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const documentsPdfCreateRoute = new Hono<AppEnv>();

// PDF generation from structured content using pdf-lib (pure JS, no Chromium).
// Route is org + workspace scoped (see app.ts).
documentsPdfCreateRoute.post("/", async (c) => {
  const body = documentsPdfCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(documentsPdfCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
