import { Hono } from "hono";
import { agentCompose } from "@oxagen/oxagen/contracts/agent.compose";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentComposeRoute = new Hono<AppEnv>();

agentComposeRoute.post("/", async (c) => {
  const body = agentCompose.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(agentCompose.name, body, ctx, { surface: "api" });
  return c.json(result);
});
