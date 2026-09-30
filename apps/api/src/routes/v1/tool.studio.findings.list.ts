import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioFindingsList } from "@oxagen/oxagen/contracts/tool.studio.findings.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the tool checks' findings on one server folder. Mounted on the org-scoped router behind session auth. */
export const toolStudioFindingsListRoute = new Hono<AppEnv>();

toolStudioFindingsListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioFindingsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioFindingsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
