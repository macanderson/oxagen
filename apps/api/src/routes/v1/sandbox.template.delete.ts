import { Hono } from "hono";
import { sandboxTemplateDelete } from "@oxagen/oxagen/contracts/sandbox.template.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateDeleteRoute = new Hono<AppEnv>();

sandboxTemplateDeleteRoute.post("/", async (c) => {
  const body = sandboxTemplateDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
