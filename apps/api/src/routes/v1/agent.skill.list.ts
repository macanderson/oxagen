import { Hono } from "hono";
import { agentSkillList } from "@oxagen/oxagen/contracts/agent.skill.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentSkillListRoute = new Hono<AppEnv>();

agentSkillListRoute.get("/", async (c) => {
  const filter = c.req.query("filter") ?? undefined;
  const input = agentSkillList.input.parse(filter ? { filter } : {});
  const ctx = capabilityContext(c);
  const out = await invoke(agentSkillList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
