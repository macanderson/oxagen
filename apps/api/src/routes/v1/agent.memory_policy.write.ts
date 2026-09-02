import { Hono } from "hono";
import { agentMemoryPolicyWrite } from "@oxagen/oxagen/contracts/agent.memory_policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryPolicyWriteRoute = new Hono<AppEnv>();

agentMemoryPolicyWriteRoute.post("/", async (c) => {
  const body = agentMemoryPolicyWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryPolicyWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
