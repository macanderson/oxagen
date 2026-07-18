import { Hono } from "hono";
import { agentMemoryPromotionDismiss } from "@oxagen/oxagen/contracts/agent.memory_promotion.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryPromotionDismissRoute = new Hono<AppEnv>();

agentMemoryPromotionDismissRoute.post("/", async (c) => {
  const body = agentMemoryPromotionDismiss.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryPromotionDismiss.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
