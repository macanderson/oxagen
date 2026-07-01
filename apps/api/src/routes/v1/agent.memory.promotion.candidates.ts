import { Hono } from "hono";
import { agentMemoryPromotionCandidates } from "@oxagen/oxagen/contracts/agent.memory.promotion.candidates";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryPromotionCandidatesRoute = new Hono<AppEnv>();

agentMemoryPromotionCandidatesRoute.post("/", async (c) => {
  const body = agentMemoryPromotionCandidates.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryPromotionCandidates.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
