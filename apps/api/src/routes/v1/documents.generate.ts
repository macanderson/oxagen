import { Hono } from "hono";
import { documentsGenerate } from "@oxagen/oxagen/contracts/documents.generate";
import { documentsGenerateHandler } from "@oxagen/handlers/documents.generate";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const documentsGenerateRoute = new Hono<AppEnv>();

// Stub document generation: parses the provider/kind/title input, logs intent,
// and returns a typed placeholder. Route is org + workspace scoped (see app.ts).
documentsGenerateRoute.post("/", async (c) => {
  const body = documentsGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await documentsGenerateHandler(body, ctx);
  return c.json(out, 200);
});
