import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { skillConfigUpdate } from "@oxagen/oxagen/contracts/skill.config.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** update_skill_config on the org-scoped router behind session auth. */
export const skillConfigUpdateRoute = new Hono<AppEnv>();

skillConfigUpdateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = skillConfigUpdate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(skillConfigUpdate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
