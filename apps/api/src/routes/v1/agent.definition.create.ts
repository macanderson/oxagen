import { Hono } from "hono";
import { agentDefinitionCreate } from "@oxagen/oxagen/contracts/agent.definition.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionCreateRoute = new Hono<AppEnv>();

agentDefinitionCreateRoute.post("/", async (c) => {
  const input = agentDefinitionCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
