import { Hono } from "hono";
import { toolDeclarationList } from "@oxagen/oxagen/contracts/tool.declaration.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const toolDeclarationListRoute = new Hono<AppEnv>();

toolDeclarationListRoute.get("/", async (c) => {
  const source = c.req.query("source");
  const limit =
    c.req.query("limit") !== undefined
      ? Number(c.req.query("limit"))
      : undefined;
  const offset =
    c.req.query("offset") !== undefined
      ? Number(c.req.query("offset"))
      : undefined;
  const input = toolDeclarationList.input.parse({ source, limit, offset });
  const ctx = capabilityContext(c);
  const out = await invoke(toolDeclarationList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
