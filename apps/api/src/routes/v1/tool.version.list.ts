import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace registry's tool versions with classification, gate and 30-day calls. Mounted on the org-scoped router behind session auth. */
export const toolVersionListRoute = new Hono<AppEnv>();

toolVersionListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolVersionList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolVersionList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
