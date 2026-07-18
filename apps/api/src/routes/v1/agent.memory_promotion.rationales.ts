import { Hono } from "hono";
import { agentMemoryPromotionRationales } from "@oxagen/oxagen/contracts/agent.memory_promotion.rationales";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryPromotionRationalesRoute = new Hono<AppEnv>();

agentMemoryPromotionRationalesRoute.post("/", async (c) => {
  const body = agentMemoryPromotionRationales.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryPromotionRationales.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
