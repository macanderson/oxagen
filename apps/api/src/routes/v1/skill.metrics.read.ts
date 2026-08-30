import { Hono } from "hono";
import { skillMetricsRead } from "@oxagen/oxagen/contracts/skill.metrics.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillMetricsReadRoute = new Hono<AppEnv>();

skillMetricsReadRoute.get("/", async (c) => {
  const skillId = c.req.query("skill_id");
  const input = skillMetricsRead.input.parse({ skillId });
  const ctx = capabilityContext(c);
  const out = await invoke(skillMetricsRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
