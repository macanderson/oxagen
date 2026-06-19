import { Hono } from "hono";
import { skillEdit } from "@oxagen/oxagen/contracts/skill.edit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillEditRoute = new Hono<AppEnv>();

skillEditRoute.post("/", async (c) => {
  const input = skillEdit.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillEdit.name, input, ctx, { surface: "api" });
  return c.json(out);
});
