import { Hono } from "hono";
import { agentDefinitionUpdate } from "@oxagen/oxagen/contracts/agent.definition.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionUpdateRoute = new Hono<AppEnv>();

agentDefinitionUpdateRoute.post("/", async (c) => {
  const input = agentDefinitionUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionUpdate.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
