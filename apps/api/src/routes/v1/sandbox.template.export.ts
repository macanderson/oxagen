import { Hono } from "hono";
import { sandboxTemplateExport } from "@oxagen/oxagen/contracts/sandbox.template.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateExportRoute = new Hono<AppEnv>();

sandboxTemplateExportRoute.post("/", async (c) => {
  const body = sandboxTemplateExport.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateExport.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
