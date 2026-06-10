import { Hono } from "hono";
import { researchSwarmStatus } from "@oxagen/oxagen/contracts/research.swarm.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const researchSwarmStatusRoute = new Hono<AppEnv>();

researchSwarmStatusRoute.get("/", async (c) => {
  const body = researchSwarmStatus.input.parse({ swarmId: c.req.query("swarmId") });
  const ctx = capabilityContext(c);
  const out = await invoke(researchSwarmStatus.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
