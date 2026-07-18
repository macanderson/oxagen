import { Hono } from "hono";
import { agentMemoryCitationStats } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryCitationStatsRoute = new Hono<AppEnv>();

agentMemoryCitationStatsRoute.post("/", async (c) => {
  const body = agentMemoryCitationStats.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryCitationStats.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
