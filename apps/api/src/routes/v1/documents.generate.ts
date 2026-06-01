import { Hono } from "hono";
import { documentsGenerate } from "@oxagen/oxagen/contracts/documents.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const documentsGenerateRoute = new Hono<AppEnv>();

// Stub document generation: parses the provider/kind/title input, logs intent,
// and returns a typed placeholder. Route is org + workspace scoped (see app.ts).
documentsGenerateRoute.post("/", async (c) => {
  const body = documentsGenerate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(documentsGenerate.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
