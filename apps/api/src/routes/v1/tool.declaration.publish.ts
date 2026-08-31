import { Hono } from "hono";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const toolDeclarationPublishRoute = new Hono<AppEnv>();

toolDeclarationPublishRoute.post("/", async (c) => {
  const input = toolDeclarationPublish.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(toolDeclarationPublish.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
