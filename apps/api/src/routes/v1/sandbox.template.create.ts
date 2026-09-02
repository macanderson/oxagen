import { Hono } from "hono";
import { sandboxTemplateCreate } from "@oxagen/oxagen/contracts/sandbox.template.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateCreateRoute = new Hono<AppEnv>();

sandboxTemplateCreateRoute.post("/", async (c) => {
  const body = sandboxTemplateCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
