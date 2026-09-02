import { Hono } from "hono";
import { sandboxTemplateImport } from "@oxagen/oxagen/contracts/sandbox.template.import";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateImportRoute = new Hono<AppEnv>();

sandboxTemplateImportRoute.post("/", async (c) => {
  const body = sandboxTemplateImport.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateImport.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
