import { Hono } from "hono";
import { sandboxTemplateList } from "@oxagen/oxagen/contracts/sandbox.template.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const sandboxTemplateListRoute = new Hono<AppEnv>();

sandboxTemplateListRoute.post("/", async (c) => {
  const body = sandboxTemplateList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(sandboxTemplateList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
