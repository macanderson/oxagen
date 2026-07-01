import { Hono } from "hono";
import { agentMemoryCite } from "@oxagen/oxagen/contracts/agent.memory.cite";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryCiteRoute = new Hono<AppEnv>();

agentMemoryCiteRoute.post("/", async (c) => {
  const body = agentMemoryCite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryCite.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
