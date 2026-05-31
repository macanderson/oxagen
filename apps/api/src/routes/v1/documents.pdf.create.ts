import { Hono } from "hono";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/documents.pdf.create";
import { documentsPdfCreateHandler } from "@oxagen/handlers/documents.pdf.create";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const documentsPdfCreateRoute = new Hono<AppEnv>();

// Stub PDF creation: parses title/source/brandKitId input, logs intent,
// and returns a typed placeholder. Route is org + workspace scoped (see app.ts).
documentsPdfCreateRoute.post("/", async (c) => {
  const body = documentsPdfCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await documentsPdfCreateHandler(body, ctx);
  return c.json(out, 200);
});
