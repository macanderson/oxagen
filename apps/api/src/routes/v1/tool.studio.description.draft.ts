import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioDescriptionDraft } from "@oxagen/oxagen/contracts/tool.studio.description.draft";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Draft a description for one Studio tool with the in-app agent. Mounted on the org-scoped router behind session auth. */
export const toolStudioDescriptionDraftRoute = new Hono<AppEnv>();

toolStudioDescriptionDraftRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioDescriptionDraft.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioDescriptionDraft.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
