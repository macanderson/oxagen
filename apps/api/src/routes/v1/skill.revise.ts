import { Hono } from "hono";
import { skillRevise } from "@oxagen/oxagen/contracts/skill.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillReviseRoute = new Hono<AppEnv>();

skillReviseRoute.post("/", async (c) => {
  const input = skillRevise.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillRevise.name, input, ctx, { surface: "api" });
  return c.json(out);
});
