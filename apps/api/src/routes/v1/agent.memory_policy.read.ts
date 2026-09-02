import { Hono } from "hono";
import { agentMemoryPolicyRead } from "@oxagen/oxagen/contracts/agent.memory_policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryPolicyReadRoute = new Hono<AppEnv>();

agentMemoryPolicyReadRoute.get("/", async (c) => {
  const input = agentMemoryPolicyRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryPolicyRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
