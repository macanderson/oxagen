import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** get_skill_config on the org-scoped router behind session auth. */
export const skillConfigGetRoute = new Hono<AppEnv>();

skillConfigGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = skillConfigGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(skillConfigGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
