import { Hono } from "hono";
import { skillVersionGet } from "@oxagen/oxagen/contracts/skill.version.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillVersionGetRoute = new Hono<AppEnv>();

skillVersionGetRoute.get("/", async (c) => {
  const skill_id = c.req.query("skill_id") ?? "";
  // version_id is optional: omitted → the skill's pinned active version.
  const version_id = c.req.query("version_id") || undefined;
  const input = skillVersionGet.input.parse({ skill_id, version_id });
  const ctx = capabilityContext(c);
  const out = await invoke(skillVersionGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
