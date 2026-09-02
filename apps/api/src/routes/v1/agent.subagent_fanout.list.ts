import { Hono } from "hono";
import { agentSubagentFanoutList } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentFanoutListRoute = new Hono<AppEnv>();

agentSubagentFanoutListRoute.get("/", async (c) => {
  const parentMessageId = c.req.query("parentMessageId") ?? undefined;
  const limitRaw = c.req.query("limit");
  const input = agentSubagentFanoutList.input.parse({
    ...(parentMessageId ? { parentMessageId } : {}),
    ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentSubagentFanoutList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
