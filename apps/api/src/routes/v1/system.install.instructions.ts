import { Hono } from "hono";
import { systemInstallInstructions } from "@oxagen/oxagen/contracts/system.install.instructions";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const systemInstallInstructionsRoute = new Hono<AppEnv>();

// Returns step-by-step MCP/CLI install instructions for a given AI client.
// Pure computation — no model call. Renders inline via install-instructions
// component in chat. Route is org + workspace scoped.
systemInstallInstructionsRoute.post("/", async (c) => {
  const body = systemInstallInstructions.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(systemInstallInstructions.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
