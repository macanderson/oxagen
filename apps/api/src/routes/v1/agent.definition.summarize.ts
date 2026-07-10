import { Hono } from "hono";
import { agentDefinitionSummarize } from "@oxagen/oxagen/contracts/agent.definition.summarize";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionSummarizeRoute = new Hono<AppEnv>();

agentDefinitionSummarizeRoute.post("/", async (c) => {
  const input = agentDefinitionSummarize.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionSummarize.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
