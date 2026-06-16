import { Hono } from "hono";
import { agentDefinitionPublish } from "@oxagen/oxagen/contracts/agent.definition.publish";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionPublishRoute = new Hono<AppEnv>();

agentDefinitionPublishRoute.post("/", async (c) => {
  const input = agentDefinitionPublish.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionPublish.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
