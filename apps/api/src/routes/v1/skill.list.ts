import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the skills this workspace's harness sessions reported at start. Mounted on the org-scoped router behind session auth. */
export const skillListRoute = new Hono<AppEnv>();

skillListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = skillList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(skillList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
