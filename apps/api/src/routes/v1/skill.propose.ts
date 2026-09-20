import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Propose a skill as a pull request against the workspace's main repository. Mounted on the org-scoped router behind session auth (ADR-090). */
export const skillProposeRoute = new Hono<AppEnv>();

skillProposeRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = skillPropose.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(skillPropose.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
