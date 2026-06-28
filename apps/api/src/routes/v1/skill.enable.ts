import { Hono } from "hono";
import { skillEnable } from "@oxagen/oxagen/contracts/skill.enable";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillEnableRoute = new Hono<AppEnv>();

skillEnableRoute.post("/", async (c) => {
  const input = skillEnable.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillEnable.name, input, ctx, { surface: "api" });
  return c.json(out);
});
