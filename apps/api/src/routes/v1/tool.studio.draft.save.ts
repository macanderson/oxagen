import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioDraftSave } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Save Studio's staged edits to one server folder as a draft. Mounted on the org-scoped router behind session auth. */
export const toolStudioDraftSaveRoute = new Hono<AppEnv>();

toolStudioDraftSaveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioDraftSave.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioDraftSave.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
