import { Hono } from "hono";
import { skillVersionList } from "@oxagen/oxagen/contracts/skill.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillVersionListRoute = new Hono<AppEnv>();

skillVersionListRoute.get("/", async (c) => {
  const skill_id = c.req.query("skill_id") ?? "";
  const limit =
    c.req.query("limit") !== undefined
      ? Number(c.req.query("limit"))
      : undefined;
  const offset =
    c.req.query("offset") !== undefined
      ? Number(c.req.query("offset"))
      : undefined;
  const input = skillVersionList.input.parse({ skill_id, limit, offset });
  const ctx = capabilityContext(c);
  const out = await invoke(skillVersionList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
