import { Hono } from "hono";
import { sandboxTemplateSetDefault } from "@oxagen/oxagen/contracts/sandbox.template.set_default";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateSetDefaultRoute = new Hono<AppEnv>();

sandboxTemplateSetDefaultRoute.post("/", async (c) => {
  const body = sandboxTemplateSetDefault.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateSetDefault.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
