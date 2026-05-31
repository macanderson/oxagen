import { Hono } from "hono";
import { formFill } from "@oxagen/oxagen/contracts/form.fill";
import { formFillHandler } from "@oxagen/handlers/form.fill";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const formFillRoute = new Hono<AppEnv>();

// Synchronous generative fill: parse the form fields + instruction, run the
// LLM, and return per-field diffs. The route is org + workspace scoped (see
// app.ts) so the capability context already carries orgId and workspaceId.
formFillRoute.post("/", async (c) => {
  const body = formFill.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await formFillHandler(body, ctx);
  return c.json(out, 200);
});
