import { Hono } from "hono";
import { agentMemoryList } from "@oxagen/oxagen/contracts/agent.memory.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryListRoute = new Hono<AppEnv>();

agentMemoryListRoute.post("/", async (c) => {
  const body = agentMemoryList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryList.name, body, ctx, { surface: "api" });
  return c.json(out);
});
