import { Hono } from "hono";
import { sandboxTemplateUpdate } from "@oxagen/oxagen/contracts/sandbox.template.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateUpdateRoute = new Hono<AppEnv>();

sandboxTemplateUpdateRoute.post("/", async (c) => {
  const body = sandboxTemplateUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateUpdate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
