import { Hono } from "hono";
import { agentSkillLoad } from "@oxagen/oxagen/contracts/agent.skill.load";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSkillLoadRoute = new Hono<AppEnv>();

agentSkillLoadRoute.post("/", async (c) => {
  const body = await c.req.json();
  const input = agentSkillLoad.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(agentSkillLoad.name, input, ctx, { surface: "api" });
  return c.json(out);
});
