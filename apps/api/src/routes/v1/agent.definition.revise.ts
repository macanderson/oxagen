import { Hono } from "hono";
import { agentDefinitionRevise } from "@oxagen/oxagen/contracts/agent.definition.revise";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionReviseRoute = new Hono<AppEnv>();

agentDefinitionReviseRoute.post("/", async (c) => {
  const input = agentDefinitionRevise.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionRevise.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
