import { Hono } from "hono";
import { agentDefinitionGet } from "@oxagen/oxagen/contracts/agent.definition.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionGetRoute = new Hono<AppEnv>();

agentDefinitionGetRoute.get("/:agentId", async (c) => {
  const input = agentDefinitionGet.input.parse({
    agentId: c.req.param("agentId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
