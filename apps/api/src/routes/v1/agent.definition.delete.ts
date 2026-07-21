import { Hono } from "hono";
import { agentDefinitionDelete } from "@oxagen/oxagen/contracts/agent.definition.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionDeleteRoute = new Hono<AppEnv>();

agentDefinitionDeleteRoute.post("/", async (c) => {
  const input = agentDefinitionDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionDelete.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
