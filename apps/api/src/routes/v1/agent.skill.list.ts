import { Hono } from "hono";
import { agentSkillList } from "@oxagen/oxagen/capabilities/agent.skill.list";
import { agentSkillListHandler } from "@oxagen/oxagen/capabilities/agent.skill.list.handler";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentSkillListRoute = new Hono<AppEnv>();

agentSkillListRoute.get("/", async (c) => {
  const filter = c.req.query("filter") ?? undefined;
  const input = agentSkillList.input.parse(filter ? { filter } : {});
  const ctx = capabilityContext(c);
  const out = await agentSkillListHandler(input, ctx);
  return c.json(out);
});
