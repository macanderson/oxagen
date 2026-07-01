import { Hono } from "hono";
import { agentMemoryCitationsList } from "@oxagen/oxagen/contracts/agent.memory.citations.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryCitationsListRoute = new Hono<AppEnv>();

agentMemoryCitationsListRoute.post("/", async (c) => {
  const body = agentMemoryCitationsList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryCitationsList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
