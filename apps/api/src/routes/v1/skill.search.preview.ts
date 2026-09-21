import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** preview_skill_search on the org-scoped router behind session auth. */
export const skillSearchPreviewRoute = new Hono<AppEnv>();

skillSearchPreviewRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = skillSearchPreview.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(skillSearchPreview.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
