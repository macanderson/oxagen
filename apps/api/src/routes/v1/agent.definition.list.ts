import { Hono } from "hono";
import { agentDefinitionList } from "@oxagen/oxagen/contracts/agent.definition.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDefinitionListRoute = new Hono<AppEnv>();

agentDefinitionListRoute.get("/", async (c) => {
  const status = c.req.query("status") ?? undefined;
  const input = agentDefinitionList.input.parse(status ? { status } : {});
  const ctx = capabilityContext(c);
  const out = await invoke(agentDefinitionList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
